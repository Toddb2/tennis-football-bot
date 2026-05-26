const axios = require('axios')
const logger = require('../utils/logger')

const CBB_UPSERT_URL = 'https://www.cloudbetbot.com/api/rpc/hooks/upsert_bets.php'
const CBB_CATALOGUE_URL = 'https://www.cloudbetbot.com/api/rpc/services/predictology/v2/market_catalogue.php'

class CbbClient {
  constructor() {
    this.service = process.env.CBB_SERVICE
    this.key = process.env.CBB_KEY
    this.id = process.env.CBB_ID
    this.isDryRun = process.env.DRY_RUN === 'true'

    // TTL cache for catalogue — avoids re-fetching same market within 30s
    this.catalogueCache = new Map()
    this.CATALOGUE_TTL_MS = 30 * 1000
  }

  // Place or update a bet via CBB
  // strategyKey matches the profile name Nigel set up in CBB (e.g. "TennisBotA")
  async upsertBet(marketId, selectionId, strategyKey, points = 1) {
    if (this.isDryRun) {
      logger.info(`[DRY RUN] Would upsert bet → marketId: ${marketId} | selectionId: ${selectionId} | strategy: ${strategyKey}`)
      return { success: true, dryRun: true }
    }

    const payload = {
      service: { id: this.id, access_key: this.key },
      bets: [{
        marketId,
        selectionId,
        active: true,
        settings_key: strategyKey,
        overrides: null,
        points
      }]
    }

    try {
      const response = await axios.post(CBB_UPSERT_URL, payload)
      logger.info(`CBB bet upserted: ${JSON.stringify(response.data)}`)
      return { success: true, data: response.data }
    } catch (error) {
      logger.error(`CBB upsert failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  }

  // Cancel/deactivate a bet via CBB
  async cancelBet(marketId, selectionId, strategyKey) {
    if (this.isDryRun) {
      logger.info(`[DRY RUN] Would cancel bet → marketId: ${marketId}`)
      return { success: true, dryRun: true }
    }

    const payload = {
      service: { id: this.id, access_key: this.key },
      bets: [{
        marketId,
        selectionId,
        active: false,
        settings_key: strategyKey,
        overrides: null,
        points: 0
      }]
    }

    try {
      const response = await axios.post(CBB_UPSERT_URL, payload)
      logger.info(`CBB bet cancelled: ${JSON.stringify(response.data)}`)
      return { success: true, data: response.data }
    } catch (error) {
      logger.error(`CBB cancel failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  }

  // Fetch tennis market catalogue from CBB
  // Used to resolve marketId + selectionId for a given match
  async getTennisCatalogue(marketParam = null) {
    const cacheKey = marketParam || 'all'
    const cached = this.catalogueCache.get(cacheKey)

    if (cached && Date.now() - cached.fetchedAt < this.CATALOGUE_TTL_MS) {
      logger.debug(`Catalogue served from cache (${cacheKey})`)
      return cached.data
    }

    const marketQuery = marketParam ? `&market=${marketParam}` : ''
    const url = `${CBB_CATALOGUE_URL}?sport=tennis&access_key=${this.key}&access_name=${this.service}${marketQuery}`

    try {
      const response = await axios.get(url)
      this.catalogueCache.set(cacheKey, { data: response.data, fetchedAt: Date.now() })
      return response.data
    } catch (error) {
      logger.error(`CBB catalogue fetch failed: ${error.message}`)
      return cached?.data || {}
    }
  }

  // Find the correct marketId and selectionId for a player in a match
  // playerName: the player to back (e.g. "Djokovic")
  // matchName: "Djokovic v Alcaraz"
  async resolveSelection(playerName, matchName) {
    const catalogue = await this.getTennisCatalogue('MATCH_ODDS')

    if (!catalogue || Object.keys(catalogue).length === 0) {
      logger.warn('No catalogue data available from CBB')
      return null
    }

    // Find the matching event
    for (const [eventId, eventData] of Object.entries(catalogue)) {
      const eventName = eventData?.name || eventData?.event || ''

      // Fuzzy match the match name
      if (!this._matchNames(matchName, eventName)) continue

      // Find the right runner (player to back)
      for (const [marketId, marketData] of Object.entries(eventData.markets || {})) {
        for (const [selectionId, runnerData] of Object.entries(marketData.runners || {})) {
          if (this._matchNames(playerName, runnerData.name || '')) {
            return { marketId, selectionId, eventName }
          }
        }
      }
    }

    logger.warn(`Could not resolve selection for: ${playerName} in ${matchName}`)
    return null
  }

  // Simple fuzzy name match (adapted from football bot)
  _matchNames(a, b) {
    const clean = s => s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    const ca = clean(a)
    const cb = clean(b)

    if (ca === cb) return true
    if (ca.includes(cb) || cb.includes(ca)) return true

    // Token matching — any significant token from a appears in b
    const tokens = ca.split(' ').filter(w => w.length > 3)
    return tokens.some(t => cb.includes(t))
  }
}

module.exports = CbbClient
