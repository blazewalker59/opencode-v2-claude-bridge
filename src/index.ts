import { Plugin } from "@opencode/plugin"
import { setupBridge } from "./plugin-setup.js"

// OpenCode loads this module's default export; the setup lives in plugin-setup.ts so tests can drive it.
const plugin = Plugin.define({
  id: "opencode-v2-claude-bridge",
  setup: (context) => setupBridge(context),
})

export default plugin
