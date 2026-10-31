/**
 * Geo tools — forward and reverse geocoding via OpenStreetMap (Nominatim).
 *
 * Provides real-time spatial resolution for coordinates and place names.
 */

import { tool } from "../lib/tool"

const USER_AGENT = "opencode-madcat (https://www.npmjs.com/package/@madcat-os/opencode-madcat)"

export const reverse = tool({
  description:
    "Reverse geocode latitude and longitude coordinates into a human-readable street address and location details. " +
    "Uses OpenStreetMap Nominatim. Returns display_name, road, house_number, neighborhood, city, and country.",
  args: {
    lat: tool.schema
      .number()
      .describe("Latitude (e.g. 52.2297)"),
    lon: tool.schema
      .number()
      .describe("Longitude (e.g. 21.0122)"),
    zoom: tool.schema
      .number()
      .optional()
      .describe("Zoom level 1-18 (default: 18 for building/house number resolution)"),
  },
  async execute(args) {
    const zoom = args.zoom ?? 18
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${args.lat}&lon=${args.lon}&zoom=${zoom}&addressdetails=1`

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) {
        throw new Error(`Nominatim HTTP ${res.status}: ${res.statusText}`)
      }

      const data = (await res.json()) as any
      const addr = data.address || {}

      return JSON.stringify({
        success: true,
        latitude: args.lat,
        longitude: args.lon,
        display_name: data.display_name,
        address: {
          house_number: addr.house_number,
          road: addr.road,
          quarter: addr.quarter,
          suburb: addr.suburb,
          city: addr.city || addr.town || addr.village,
          state: addr.state,
          postcode: addr.postcode,
          country: addr.country,
          country_code: addr.country_code,
        },
      })
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err?.message ?? String(err),
        latitude: args.lat,
        longitude: args.lon,
      })
    }
  },
})

export const search = tool({
  description:
    "Forward geocode a place name, street address, or landmark into coordinates (latitude, longitude) and address details. " +
    "Uses OpenStreetMap Nominatim.",
  args: {
    query: tool.schema
      .string()
      .describe("Address, city, or place name to search for (e.g. 'Warsaw Central Station' or 'Nowaka-Jeziorańskiego 9 Warszawa')"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Max number of search results (default: 3)"),
  },
  async execute(args) {
    const limit = args.limit ?? 3
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(args.query)}&limit=${limit}&addressdetails=1`

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) {
        throw new Error(`Nominatim HTTP ${res.status}: ${res.statusText}`)
      }

      const data = (await res.json()) as any[]

      const results = (data || []).map((item) => ({
        latitude: parseFloat(item.lat),
        longitude: parseFloat(item.lon),
        display_name: item.display_name,
        type: item.type,
        address: item.address,
      }))

      return JSON.stringify({
        success: true,
        query: args.query,
        count: results.length,
        results,
      })
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: err?.message ?? String(err),
        query: args.query,
      })
    }
  },
})
