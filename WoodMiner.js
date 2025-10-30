const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear, GoalFollow } = goals
const collectBlock = require('mineflayer-collectblock').plugin

const VERSION = '1.21.8'

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'MinerBot',
  version: VERSION
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)

let mcData

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function checkForAxe() {
  return bot.inventory.items().some(i => i.name === 'diamond_axe')
}

function findNearestPlayer() {
  const players = Object.values(bot.players)
    .filter(p => p.entity && p.username !== bot.username)
  if (players.length === 0) return null
  players.sort((a, b) => bot.entity.position.distanceTo(a.entity.position) - bot.entity.position.distanceTo(b.entity.position))
  return players[0]
}

async function followPlayerUntilAxe() {
  while (!checkForAxe()) {
    const player = findNearestPlayer()
    if (!player || !player.entity) {
      console.log('⚠️ Žiadny hráč – čakám...')
      await sleep(3000)
      continue
    }

    bot.chat('Potrebujem sekeru')
    const defaultMove = new Movements(bot, mcData)
    bot.pathfinder.setMovements(defaultMove)
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true)
    await sleep(4000)
  }

  bot.pathfinder.setGoal(null)
  bot.chat('Ďakujem! Idem ťažiť drevo.')
}

function findDroppedLogs(maxDistance = 32) {
  const logs = []
  for (const entityId in bot.entities) {
    const entity = bot.entities[entityId]
    if (entity.name === 'item' && entity.item) {
      const itemName = mcData.items[entity.item.type]?.name
      if (itemName && itemName.includes('log') && bot.entity.position.distanceTo(entity.position) <= maxDistance) {
        logs.push(entity)
      }
    }
  }
  logs.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
  return logs
}

async function collectDroppedLogs() {
  let logs = findDroppedLogs()
  while (logs.length > 0) {
    const log = logs[0]
    try {
      await bot.pathfinder.goto(new GoalNear(log.position.x, log.position.y, log.position.z, 1.2))
      await sleep(600)
    } catch (err) {
      console.log('❌ Chyba pri zbieraní dropped logu:', err.message)
    }
    await sleep(300)
    logs = findDroppedLogs()
  }
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

async function depositLogsToChest(chestBlock) {
  const logsInInventory = bot.inventory.items().filter(item => {
    const itemName = mcData.items[item.type]?.name
    return itemName && itemName.includes('log')
  })

  if (logsInInventory.length === 0) {
    console.log('📭 Žiadne drevo na uloženie.')
    return
  }

  console.log(`🗄️ Približujem sa k chest na ${chestBlock.position}...`)

  const defaultMove = new Movements(bot, mcData)
  bot.pathfinder.setMovements(defaultMove)
  try {
    await bot.pathfinder.goto(new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 1.3))
  } catch (err) {
    console.log('❌ Nepodarilo sa priblížiť k chestu.')
    return
  }

  await sleep(300)
  lookAtBlock(chestBlock)
  await sleep(200)

  const currentBlock = bot.blockAt(chestBlock.position)
  if (!currentBlock || !['chest', 'trapped_chest'].includes(currentBlock.name)) {
    console.log('❌ Chest zmizla alebo je poškodená.')
    return
  }

  let chestWindow
  try {
    chestWindow = await bot.openChest(currentBlock)
  } catch (err) {
    console.log('❌ Nepodarilo sa otvoriť chest:', err.message)
    return
  }

  try {
    for (const item of logsInInventory) {
      await chestWindow.deposit(item.type, null, item.count)
      console.log(`✅ Vložené ${item.count}x ${mcData.items[item.type].name}`)
      await sleep(150)
    }
  } catch (err) {
    console.log('❌ Chyba pri vkladaní:', err.message)
  } finally {
    chestWindow.close()
    console.log('🔒 Chest zatvorená.')
  }
}

function findNearestTree() {
  return bot.findBlock({
    matching: block => {
      const name = mcData.blocks[block.type]?.name
      return name && name.includes('log')
    },
    maxDistance: 64
  })
}

async function mainLoop() {
  while (true) {
    try {
      await collectDroppedLogs()

      const chest = findNearestChest()
      if (chest) {
        await depositLogsToChest(chest)
      } else {
        console.log('⚠️ Žiadna chest v dosahu.')
      }

      const hasLogs = bot.inventory.items().some(item => {
        const name = mcData.items[item.type]?.name
        return name && name.includes('log')
      })

      if (!hasLogs) {
        if (!checkForAxe()) {
          await followPlayerUntilAxe()
        }

        const tree = findNearestTree()
        if (tree) {
          const defaultMove = new Movements(bot, mcData)
          bot.pathfinder.setMovements(defaultMove)
          await bot.pathfinder.goto(new GoalNear(tree.position.x, tree.position.y, tree.position.z, 1))
          console.log(`🪓 Ťažím strom na ${tree.position}`)
          await bot.collectBlock.collect(tree)
        } else {
          console.log('⚠️ Žiadny strom – čakám...')
          await sleep(3000)
          continue
        }
      }

      await sleep(800)
    } catch (err) {
      console.log('❌ Chyba v cykle:', err.message)
      await sleep(2000)
    }
  }
}

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)
  console.log(`✅ Bot pripojený (verzia: ${bot.version})`)
  mainLoop()
})

bot.on('error', err => console.log('❌ Bot error:', err.message))
bot.on('end', () => console.log('❌ Bot odpojený'))
