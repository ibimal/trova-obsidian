import { describe, expect, it } from "vitest";
import { spawnCommand, withPath } from "../src/engine/launcher.js";

describe("starting the engine", () => {
  it("starts the binary directly on macOS and Linux, with no shell", () => {
    expect(spawnCommand("/opt/homebrew/bin/trova", ["watch"], "darwin")).toEqual({ command: "/opt/homebrew/bin/trova", args: ["watch"], windowsVerbatimArguments: false });
    expect(spawnCommand("/home/me/my tools/trova", ["watch"], "linux").command).toBe("/home/me/my tools/trova");
  });

  it("starts a Windows .exe directly", () => {
    expect(spawnCommand("C:\\Program Files\\trova\\trova.exe", ["watch"], "win32")).toEqual({ command: "C:\\Program Files\\trova\\trova.exe", args: ["watch"], windowsVerbatimArguments: false });
  });

  it("starts npm's .cmd wrapper through cmd.exe with the path escaped", () => {
    const run = spawnCommand("C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\trova.cmd", ["watch"], "win32", "C:\\Windows\\system32\\cmd.exe");
    expect(run.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(run.windowsVerbatimArguments).toBe(true);
    expect(run.args).toEqual(["/d", "/s", "/c", '"C:\\Users\\Jane^ Doe\\AppData\\Roaming\\npm\\trova.cmd watch"']);
  });

  it("escapes every cmd.exe metacharacter, so a path cannot add a command", () => {
    const binary = "C:\\R&D (x86)\\100%!\\a|b<c>d^e\\trova.BAT";
    const line = spawnCommand(binary, ["watch"], "win32").args[3]!.slice(1, -1);
    // Every metacharacter carries a caret, and removing the carets gives the path back.
    expect(line).not.toMatch(/(^|[^^])[&|<>()%!]/);
    expect(line.replace(/\^(.)/g, "$1")).toBe(`${binary} watch`);
  });

  it("falls back to cmd.exe when ComSpec is not set", () => {
    expect(spawnCommand("C:\\npm\\trova.cmd", ["watch"], "win32").command).toBe("cmd.exe");
  });
});

describe("the engine's search path", () => {
  it("keeps Windows' Path spelling and leaves one search-path variable", () => {
    const env = withPath({ Path: "C:\\old", HOME: "x" }, "C:\\new");
    expect(env).toEqual({ Path: "C:\\new", HOME: "x" });
  });

  it("replaces every spelling when an environment has more than one", () => {
    const env = withPath({ PATH: "/a", Path: "/b" }, "/c");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toHaveLength(1);
    expect(Object.values(env)).toEqual(["/c"]);
  });

  it("adds PATH when the environment has none", () => {
    expect(withPath({}, "/usr/bin")).toEqual({ PATH: "/usr/bin" });
  });
});
