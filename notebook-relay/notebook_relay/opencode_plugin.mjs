import { basename } from "node:path";

export default {
  id: "notebook-relay-context",
  async setup(ctx) {
    const location = basename(ctx.location.directory);
    if (!/^nr_[a-f0-9]{32}$/.test(location)) return;
    const base = process.env.NOTEBOOK_RELAY_CONTROL_URL;
    const key = process.env.NOTEBOOK_RELAY_PLUGIN_KEY;
    const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/.exec(base || "");
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || !key) {
      throw new Error("Notebook relay control configuration is invalid");
    }
    const prefix = `${base.replace(/\/$/, "")}/internal/opencode/contexts/${location}`;
    const headers = { "X-Relay-Plugin-Key": key };
    async function control(path, options = {}) {
      const response = await fetch(`${prefix}${path}`, {
        ...options,
        redirect: "error",
        headers: { ...headers, ...options.headers },
      });
      if (!response.ok) throw new Error(`Notebook relay control ${path || "context"} failed`);
      return response;
    }
    const caller = await (await control("")).json();
    const names = new Set(caller.tools.map((tool) => tool.alias));
    await ctx.tool.transform((editor) => {
      for (const tool of caller.tools) {
        editor.add({
          name: tool.alias,
          description: tool.description,
          input: tool.parameters,
          options: { codemode: false },
          async execute(input, context) {
            await control("/tool", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ call_id: context.id, name: tool.alias, input }),
              signal: context.signal,
            });
            throw new Error("Notebook relay external tool request ended");
          },
        });
      }
    });
    await ctx.tool.hook("execute.before", (event) => {
      if (!names.has(event.tool)) throw new Error("Notebook relay external tools only");
    });
    await ctx.session.hook("context", (event) => {
      event.system = caller.system;
      event.messages = caller.messages;
      event.options = { ...event.options, ...caller.options };
    });
    let primaryRequests = 0;
    await ctx.session.hook("http.request", (event) => {
      if (event.kind === "primary" && ++primaryRequests > 1) {
        throw new Error("Notebook relay allows one primary model request");
      }
    });
    await ctx.session.hook("retry", (event) => {
      event.decision = { retry: false };
    });
    await ctx.session.hook("http.response", async (event) => {
      if (event.kind !== "primary") return;
      const copy = event.response.clone();
      await control("/response", {
        method: "POST",
        headers: {
          "x-upstream-status": String(copy.status),
          "x-upstream-content-type": copy.headers.get("content-type") || "",
          "x-upstream-retry-after": copy.headers.get("retry-after") || "",
        },
        body: copy.body,
        duplex: "half",
      });
    });
    await control("/registered", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aliases: caller.aliases }),
    });
  },
};
