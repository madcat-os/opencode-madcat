import { describe, expect, test } from "bun:test"
import { ConfigError, parseMesh } from "../src/config.ts"

const real = `
[whatsapp]
bridge_url = "http://localhost:7591"

[mesh]
self = "fuji"

[mesh.forge]
url = "http://forge:4096/api"
username = "opencode"
password = "secret"

[mesh.fuji]
url = "http://fuji.lan:49374/"
password = "other"
directory = "/Volumes/MOBILE/Projects"
`

describe("parseMesh", () => {
  test("reads hosts from [mesh.<name>] sub-tables and self from the scalar", () => {
    const mesh = parseMesh(real)
    expect(mesh.self).toBe("fuji")
    expect(mesh.hosts.map((h) => h.name)).toEqual(["forge", "fuji"])
  })

  test("strips /api and trailing slashes from urls", () => {
    const [forge, fuji] = parseMesh(real).hosts
    expect(forge?.url).toBe("http://forge:4096")
    expect(fuji?.url).toBe("http://fuji.lan:49374")
  })

  test("defaults username to opencode and leaves directory optional", () => {
    const [forge, fuji] = parseMesh(real).hosts
    expect(forge?.username).toBe("opencode")
    expect(forge?.directory).toBeUndefined()
    expect(fuji?.directory).toBe("/Volumes/MOBILE/Projects")
  })

  test("falls back to MADCAT_MESH_SELF when self is absent", () => {
    const prev = process.env.MADCAT_MESH_SELF
    process.env.MADCAT_MESH_SELF = "forge"
    try {
      expect(parseMesh(real.replace('self = "fuji"', "")).self).toBe("forge")
    } finally {
      if (prev === undefined) delete process.env.MADCAT_MESH_SELF
      else process.env.MADCAT_MESH_SELF = prev
    }
  })

  test("rejects a self that has no host table", () => {
    expect(() => parseMesh(real.replace('self = "fuji"', 'self = "sin"'))).toThrow(ConfigError)
  })

  test("rejects hosts without url or password", () => {
    expect(() => parseMesh('[mesh]\nself = "a"\n[mesh.a]\npassword = "x"')).toThrow(/needs a url/)
    expect(() => parseMesh('[mesh]\nself = "a"\n[mesh.a]\nurl = "http://a"')).toThrow(/needs a password/)
  })

  test("rejects a missing [mesh] section", () => {
    expect(() => parseMesh("[other]\nx = 1")).toThrow(/no \[mesh\]/)
  })
})
