export default {
  id: "notebook-relay-native-tool-probe",
  async setup(ctx) {
    const base = process.env.NOTEBOOK_RELAY_PROBE_BROKER;
    const key = process.env.NOTEBOOK_RELAY_PROBE_KEY;
    if (!base || !key) throw new Error("Probe broker is not configured");
    const headers = { Authorization: `Bearer ${key}` };

    if (process.env.NOTEBOOK_RELAY_PROBE_CONTEXT === "1") {
      await ctx.session.hook("context", async (event) => {
        const response = await fetch(`${base}/context`, { headers });
        if (!response.ok) throw new Error("Caller context unavailable");
        const caller = await response.json();
        const marker = event.messages.findIndex((message) => message.role === "user"
          && message.content.some((part) => part.type === "text"
            && part.text.includes("NATIVE_BRIDGE_INPUT")));
        if (marker < 0) throw new Error("Isolated input marker missing");
        event.system = [{ type: "text", text: caller.system }];
        event.messages = [
          ...caller.messages.map((message) => ({
            role: message.role,
            content: [{ type: "text", text: message.content }],
          })),
          ...event.messages.slice(marker + 1),
        ];
      });
    }

    await ctx.session.hook("http.request", async (event) => {
      if (event.kind !== "primary") return;
      const body = await event.request.clone().json();
      const captured = await fetch(`${base}/request-summary`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: body.messages,
          tool_names: (body.tools || []).map((tool) => tool.function?.name),
        }),
      });
      if (!captured.ok) throw new Error("Request observation failed");
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "relay_probe_sum",
        description: "Ask the external client to add two integers, then receive its result.",
        input: {
          type: "object",
          properties: { a: { type: "integer" }, b: { type: "integer" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const response = await fetch(`${base}/tool`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ call_id: context.id, input }),
            signal: context.signal,
          });
          if (!response.ok) throw new Error("External tool result unavailable");
          const data = await response.json();
          return { content: data.result };
        },
      });
    });
    await ctx.session.hook("retry", (event) => {
      event.decision = { retry: false };
    });
    await ctx.session.hook("http.response", async (event) => {
      if (event.kind !== "primary") return;
      // Observe a clone: the native request, response and tool registry remain genuine.
      const copy = event.response.clone();
      const result = await fetch(`${base}/observe`, {
        method: "POST",
        headers: {
          ...headers,
          "x-upstream-status": String(copy.status),
          "x-upstream-type": copy.headers.get("content-type") || "",
        },
        body: await copy.arrayBuffer(),
      });
      if (!result.ok) throw new Error("Probe observation failed");
    });
  },
};
