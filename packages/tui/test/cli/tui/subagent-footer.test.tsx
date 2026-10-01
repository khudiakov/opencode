/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { SubagentFooter } from "../../../src/routes/session/subagent-footer"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { wait } from "../cmd/tui/sync-fixture"

test("subagent footer renders the reactive child's effort before output and preserves usage/navigation", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const model = { id: "child-model", providerID: "test", variant: "high" }
  const child: Session = {
    id: "ses_child",
    slug: "child",
    projectID: "proj_test",
    directory,
    parentID: "ses_parent",
    title: "Inspect (@explore subagent)",
    version: "1",
    model,
    cost: 0.25,
    time: { created: 1, updated: 1 },
  }
  const sibling: Session = { ...child, id: "ses_sibling", model: undefined, time: { created: 2, updated: 2 } }
  const parent: Session = {
    ...child,
    id: "ses_parent",
    parentID: undefined,
    model: { id: "parent-model", providerID: "test", variant: "low" },
  }
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([child, parent, sibling])
    if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
    if (url.pathname === "/project/proj_test/directories") return json([])
  })
  const config = createTuiResolvedConfig()
  let sync!: ReturnType<typeof useSync>
  let route!: ReturnType<typeof useRoute>

  function Probe() {
    sync = useSync()
    route = useRoute()
    return <SubagentFooter />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ArgsProvider>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <OpencodeKeymapProvider keymap={keymap}>
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <RouteProvider initialRoute={{ type: "session", sessionID: child.id }}>
                              <Probe />
                            </RouteProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </OpencodeKeymapProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </ArgsProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 6 })
  async function frame() {
    await app.renderOnce()
    await app.renderOnce()
    return app.captureCharFrame()
  }
  async function update(model: Session["model"]) {
    events.emit({
      directory,
      project: "proj_test",
      payload: {
        id: "evt_session",
        type: "session.updated",
        properties: { sessionID: child.id, info: { ...child, model } },
      },
    })
    await wait(() => {
      const current = sync.session.get(child.id)?.model
      return current?.id === model?.id && current?.variant === model?.variant
    })
    return frame()
  }

  try {
    await wait(() => sync?.status === "complete")
    const startup = await frame()
    expect(sync.data.message[child.id] ?? []).toEqual([])
    expect(startup).toContain("Explore (1 of 2) · high")
    expect(startup).not.toContain("low")
    expect(startup).toContain("Parent")
    expect(startup).toContain("Prev")
    expect(startup).toContain("Next")

    const message: AssistantMessage = {
      id: "msg_child",
      sessionID: child.id,
      role: "assistant",
      time: { created: 3 },
      parentID: "msg_user",
      modelID: "child-model",
      providerID: "test",
      mode: "explore",
      agent: "explore",
      path: { cwd: directory, root: directory },
      variant: "high",
      cost: 0,
      tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    events.emit({
      directory,
      project: "proj_test",
      payload: { id: "evt_message", type: "message.updated", properties: { sessionID: child.id, info: message } },
    })
    await wait(() => sync.data.message[child.id]?.length === 1)
    expect(await update({ ...model, id: "updated-child-model", variant: "xhigh" })).toContain("· xhigh")

    events.emit({
      directory,
      project: "proj_test",
      payload: {
        id: "evt_output",
        type: "message.updated",
        properties: { sessionID: child.id, info: { ...message, tokens: { ...message.tokens, output: 20 } } },
      },
    })
    await wait(() => {
      const current = sync.data.message[child.id]?.[0]
      return current?.role === "assistant" && current.tokens.output === 20
    })
    expect(await frame()).toContain("· xhigh 120 · $0.25")

    expect(await update({ ...model, variant: "default" })).toContain("Explore (1 of 2) 120 · $0.25")
    expect(await frame()).not.toContain("default")
    expect(await update({ ...model, variant: undefined })).toContain("Explore (1 of 2) 120 · $0.25")
    expect(await update(undefined)).toContain("Explore (1 of 2) 120 · $0.25")

    await update(child.model)
    route.navigate({ type: "session", sessionID: sibling.id })
    expect(await frame()).toContain("Explore (2 of 2)")
    expect(await frame()).not.toContain("high")
    route.navigate({ type: "session", sessionID: child.id })
    expect(await frame()).toContain("Explore (1 of 2) · high 120 · $0.25")
  } finally {
    app.renderer.destroy()
  }
})
