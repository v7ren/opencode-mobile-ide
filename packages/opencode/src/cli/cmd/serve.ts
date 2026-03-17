import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
import { spawn } from "child_process"
import path from "path"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    
    // Start the API server
    const server = Server.listen(opts)
    console.log(`opencode API server listening on http://${server.hostname}:${server.port}`)
    
    // Start Vite dev server in parallel if running locally
    if (Installation.isLocal()) {
      const repoPath = process.cwd()
      const appPath = path.join(repoPath, "..", "app")
      
      console.log(`Starting Vite dev server for frontend...`)
      const vite = spawn("bun", ["run", "dev", "--port", "3000"], {
        cwd: appPath,
        stdio: "inherit",
        shell: true,
      })
      
      console.log(`Frontend dev server will be available at http://localhost:3000`)
      console.log(`API server is available at http://${server.hostname}:${server.port}`)
      
      // Handle cleanup
      process.on("SIGINT", () => {
        vite.kill("SIGINT")
        server.stop()
        process.exit(0)
      })
      
      process.on("SIGTERM", () => {
        vite.kill("SIGTERM")
        server.stop()
        process.exit(0)
      })
    }

    await new Promise(() => {})
    await server.stop()
  },
})
