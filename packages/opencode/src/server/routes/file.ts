import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "../../file"
import { FileWatcher } from "../../file/watcher"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { Bus } from "../../bus"
import { Filesystem } from "../../util/filesystem"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import path from "path"

export const FileRoutes = lazy(() =>
  new Hono()
    .put(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write content to a specified text file. Only text files are supported.",
        operationId: "file.write",
        responses: {
          200: {
            description: "File written successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          content: z.string(),
          encoding: z.literal("utf-8").optional(),
        }),
      ),
      async (c) => {
        const { path: filePath, content } = c.req.valid("json")
        const full = path.join(Instance.directory, filePath)

        if (!Instance.containsPath(full)) {
          return c.json({ message: "Access denied: path escapes project directory" }, 403)
        }

        // Check if file is binary by extension (reuse logic from file/index.ts)
        const binaryExtensions = new Set([
          "exe", "dll", "pdb", "bin", "so", "dylib", "o", "a", "lib", "wav", "mp3", "ogg", "oga", "ogv", "ogx",
          "flac", "aac", "wma", "m4a", "weba", "mp4", "avi", "mov", "wmv", "flv", "webm", "mkv", "zip", "tar",
          "gz", "gzip", "bz", "bz2", "bzip", "bzip2", "7z", "rar", "xz", "lz", "z", "pdf", "doc", "docx",
          "ppt", "pptx", "xls", "xlsx", "dmg", "iso", "img", "vmdk", "ttf", "otf", "woff", "woff2", "eot",
          "sqlite", "db", "mdb", "apk", "ipa", "aab", "xapk", "app", "pkg", "deb", "rpm", "snap", "flatpak",
          "appimage", "msi", "msp", "jar", "war", "ear", "class", "kotlin_module", "dex", "vdex", "odex",
          "oat", "art", "wasm", "wat", "bc", "ll", "s", "ko", "sys", "drv", "efi", "rom", "com", "cmd",
          "ps1", "sh", "bash", "zsh", "fish",
        ])
        
        const imageExtensions = new Set([
          "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff", "svg", "svgz", "avif", "apng",
          "jxl", "heic", "heif", "raw", "cr2", "nef", "arw", "dng", "orf", "raf", "pef", "x3f",
        ])

        const ext = path.extname(filePath).toLowerCase().slice(1)
        if (binaryExtensions.has(ext) || imageExtensions.has(ext)) {
          return c.json({ message: "Cannot write binary or image files" }, 400)
        }

        // Write the file
        await Filesystem.write(full, content)

        // Publish events for watcher/LSP integration
        await Bus.publish(File.Event.Edited, { file: full })
        await Bus.publish(FileWatcher.Event.Updated, { file: full, event: "change" })
        await LSP.touchFile(full, true)

        return c.json(true)
      },
    )
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    ),
)
