const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalFollow } = goals
const collectBlock = require('mineflayer-collectblock').plugin
const fs = require('fs')
const path = require('path')

const VERSION = '1.21.8'
const TOOLS_FILE = path.join(__dirname, 'tools.json')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'MinerBot',
  version: VERSION
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)

let mcData
let currentTask = null
let miningLoopActive = false
let minedCount = 0 // počítadlo pre !max_10
let max10Mode = false // či je aktívny mód !max_10

// Načítaj nástroje
function loadSavedTools() {
  if (fs.existsSync(TOOLS_FILE)) {
    try {
      JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'))
    } catch (err) {
      console.log('⚠️ Chyba pri načítaní nástrojov:', err.message)
    }
  }
}

// Ulož nástroje
function saveCurrentTools() {
  const tools = { wood: null, dirt: null, iron: null }
  const items = bot.inventory.items()
  for (const item of items) {
    if (item.name.endsWith('_axe')) tools.wood = item.name
    else if (item.name.endsWith('_shovel')) tools.dirt = item.name
    else if (item.name.endsWith('_pickaxe')) tools.iron = item.name
  }
  try {
    fs.writeFileSync(TOOLS_FILE, JSON.stringify(tools, null, 2))
  } catch (err) {
    console.log('❌ Chyba pri ukladaní:', err.message)
  }
}

// Nájdi nástroj
function findToolForTask(task) {
  const items = bot.inventory.items()
  if (task === 'wood') return items.find(i => i.name.endsWith('_axe'))
  if (task === 'dirt') return items.find(i => i.name.endsWith('_shovel'))
  if (task === 'iron') return items.find(i => i.name.endsWith('_pickaxe'))
  return null
}

function getToolNameForTask(task) {
  if (task === 'wood') return 'sekery'
  if (task === 'dirt') return 'lopata'
  if (task === 'iron') return 'krompáča'
  return 'nástroja'
}

const BLOCKS = {
  wood: block => {
    const name = mcData.blocks[block.type]?.name
    return name && name.includes('log')
  },
  dirt: block => {
    const name = mcData.blocks[block.type]?.name
    return ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium'].includes(name)
  },
  iron: block => {
    const name = mcData.blocks[block.type]?.name
    return name === 'iron_ore' && block.position.y < 60
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findNearestPlayer() {
  const players = Object.values(bot.players)
    .filter(p => p.entity && p.username !== bot.username)
  if (players.length === 0) return null
  players.sort((a, b) => bot.entity.position.distanceTo(a.entity.position) - bot.entity.position.distanceTo(b.entity.position))
  return players[0]
}

async function followPlayerUntilHasTool(task) {
  const toolNameHuman = getToolNameForTask(task)
  while (!findToolForTask(task)) {
    const player = findNearestPlayer()
    if (!player || !player.entity) {
      await sleep(3000)
      continue
    }

    bot.chat(`Potrebujem ${toolNameHuman}!`)
    const defaultMove = new Movements(bot, mcData)
    bot.pathfinder.setMovements(defaultMove)
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true)
    await sleep(4000)
  }

  bot.pathfinder.setGoal(null)
  bot.chat(`Ďakujem! Začínam ťažiť ${task}.`)
}

function findNearestChest(maxDistance = 64) {
  const chestIds = [
    mcData.blocksByName.chest?.id,
    mcData.blocksByName.trapped_chest?.id
  ].filter(id => id != null)

  const chests = bot.findBlocks({
    matching: chestIds,
    maxDistance: maxDistance,
    count: 1
  })

  return chests.length > 0 ? bot.blockAt(chests[0]) : null
}

function lookAtBlock(block) {
  const center = block.position.offset(0.5, 0.5, 0.5)
  bot.lookAt(center)
}

async function depositAllThatFit(chestBlock) {
  const itemsToStore = bot.inventory.items().filter(item => 
    !item.name.endsWith('_axe') &&
    !item.name.endsWith('_shovel') &&
    !item.name.endsWith('_pickaxe')
  )

  if (itemsToStore.length === 0) return true

  const defaultMove = new Movements(bot, mcData)
  bot.pathfinder.setMovements(defaultMove)
  try {
    await bot.pathfinder.goto(new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 1.3))
  } catch (err) {
    return false
  }

  await sleep(300)
  lookAtBlock(chestBlock)
  await sleep(200)

  const currentBlock = bot.blockAt(chestBlock.position)
  if (!currentBlock || !['chest', 'trapped_chest'].includes(currentBlock.name)) {
    return false
  }

  let chestWindow
  try {
    chestWindow = await bot.openChest(currentBlock)
  } catch (err) {
    return false
  }

  let deposited = 0
  try {
    for (const item of itemsToStore) {
      try {
        await chestWindow.deposit(item.type, null, item.count)
        deposited += item.count
        await sleep(100)
      } catch (err) {
        break
      }
    }
  } finally {
    chestWindow.close()
  }

  if (deposited === 0) {
    bot.chat('Hotovo, bedňa plná! Pridajte prosím ďalšiu :D')
    return false
  }

  return true
}

// Nová funkcia: uložiť všetko po dosiahnutí 10
async function tryDepositAfter10() {
  if (!max10Mode) return
  minedCount++
  console.log(`⛏️ Vyťažených: ${minedCount}/10`)

  if (minedCount >= 10) {
    bot.chat('✅ Dosiahol som 10 blokov! Ukladám do bedne...')
    const chest = findNearestChest()
    if (chest) {
      await depositAllThatFit(chest)
    } else {
      bot.chat('❌ Žiadna bedňa na uloženie!')
    }
    minedCount = 0 // reset
  }
}

async function miningLoop(task) {
  currentTask = task
  miningLoopActive = true

  while (miningLoopActive && currentTask === task) {
    try {
      const tool = findToolForTask(task)
      if (!tool) {
        await followPlayerUntilHasTool(task)
      }

      const finalTool = findToolForTask(task)
      if (!finalTool) {
        currentTask = null
        miningLoopActive = false
        return
      }

      await bot.equip(finalTool, 'hand')

      const block = bot.findBlock({
        matching: BLOCKS[task],
        maxDistance: 64
      })

      if (!block) {
        await sleep(3000)
        continue
      }

      const defaultMove = new Movements(bot, mcData)
      bot.pathfinder.setMovements(defaultMove)
      await bot.pathfinder.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 1))
      await bot.collectBlock.collect(block)

      // Tu zvýšime počítadlo
      tryDepositAfter10()

      // Normálne ukladanie pri 50% inventára
      if (bot.inventory.items().length >= 18) {
        const chest = findNearestChest()
        if (chest) {
          const success = await depositAllThatFit(chest)
          if (!success) {
            let waiting = true
            while (waiting && currentTask === task) {
              await sleep(5000)
              const success2 = await depositAllThatFit(chest)
              if (success2) waiting = false
            }
          }
        }
      }

      await sleep(500)

    } catch (err) {
      await sleep(2000)
    }
  }

  currentTask = null
  miningLoopActive = false
}

// ✅ Opravený teleport – čakáme na hráčov
async function teleportNearPlayer() {
  // Čakáme, kým sa načítajú chunky a hráči
  await bot.waitForChunksToLoad()
  await sleep(1000) // extra čas pre načítanie hráčov

  const player = findNearestPlayer()
  if (!player || !player.entity) {
    console.log('⚠️ Žiadny hráč na teleport.')
    return
  }

  const yaw = player.entity.yaw
  const offsetX = -Math.sin(yaw) * 2
  const offsetZ = Math.cos(yaw) * 2
  const targetPos = player.entity.position.offset(offsetX, 0, offsetZ)

  const defaultMove = new Movements(bot, mcData)
  bot.pathfinder.setMovements(defaultMove)
  try {
    await bot.pathfinder.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1))
    console.log(`✅ Teleportovaný 2 bloky od hráča ${player.username}`)
  } catch (err) {
    console.log('❌ Chyba pri teleporte:', err.message)
  }
}

bot.once('spawn', async () => {
  mcData = require('minecraft-data')(bot.version)
  console.log(`✅ Bot pripojený (verzia: ${bot.version})`)

  loadSavedTools()
  bot.chat('Ahoj! Som Bot Miner! Príkazy: !wood, !dirt a !iron\nPotrebujem aj náradie')

  // Spusti teleport v samostatnom vlákne
  teleportNearPlayer().catch(err => console.log('Teleport error:', err))
})

bot.on('chat', async (username, message) => {
  if (username === bot.username) return

  // Príkaz !max_10
  if (message === '!max_10') {
    max10Mode = true
    minedCount = 0
    bot.chat('✅ Mód "ulož po 10 blokoch" aktivovaný!')
  }

  // Zastavenie
  if (message === '!stop_wood') {
    if (currentTask === 'wood') {
      currentTask = null
      miningLoopActive = false
      bot.chat('Kam mám ísť?\nPríkaz !come_to <x>, <y>, <z>')
    }
  } else if (message === '!stop_dirt') {
    if (currentTask === 'dirt') {
      currentTask = null
      miningLoopActive = false
      bot.chat('Kam mám ísť?\nPríkaz !come_to <x>, <y>, <z>')
    }
  } else if (message === '!stop_iron') {
    if (currentTask === 'iron') {
      currentTask = null
      miningLoopActive = false
      bot.chat('Kam mám ísť?\nPríkaz !come_to <x>, <y>, <z>')
    }
  }
  // !wibm
  else if (message === '!wibm') {
    bot.chat(currentTask ? `Ťažím ${currentTask}` : 'Nič neťažím.')
  }
  // !come_to
  else if (message.startsWith('!come_to')) {
    const coords = message.substring(10).split(',').map(s => parseFloat(s.trim()))
    if (coords.length === 3 && !coords.some(isNaN)) {
      const [x, y, z] = coords
      bot.chat(`Prichádzam na [${x}, ${y}, ${z}]`)
      const defaultMove = new Movements(bot, mcData)
      bot.pathfinder.setMovements(defaultMove)
      try {
        await bot.pathfinder.goto(new GoalNear(x, y, z, 1))
        bot.chat('✅ Som tu!')
      } catch (err) {
        bot.chat('❌ Nepodarilo sa dostať na pozíciu.')
      }
    } else {
      bot.chat('❌ Zlý formát! Použi: !come_to x, y, z')
    }
  }
  // Spustenie úloh
  else if (message === '!wood') {
    if (currentTask) {
      bot.chat(`Už ťažím ${currentTask}. Použi !stop_${currentTask} najskôr.`)
    } else {
      bot.chat('✅ Spúšťam nekonečnú ťažbu dreva!')
      miningLoop('wood')
    }
  } else if (message === '!dirt') {
    if (currentTask) {
      bot.chat(`Už ťažím ${currentTask}. Použi !stop_${currentTask} najskôr.`)
    } else {
      bot.chat('✅ Spúšťam nekonečnú ťažbu hliny!')
      miningLoop('dirt')
    }
  } else if (message === '!iron') {
    if (currentTask) {
      bot.chat(`Už ťažím ${currentTask}. Použi !stop_${currentTask} najskôr.`)
    } else {
      bot.chat('✅ Spúšťam nekonečnú ťažbu železa!')
      miningLoop('iron')
    }
  }
})

bot.on('end', () => {
  saveCurrentTools()
  console.log('❌ Bot odpojený')
})

bot.on('error', err => console.log('❌ Bot error:', err.message))
