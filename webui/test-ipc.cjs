const { chromium } = require("playwright");
(async () => {
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9300", { timeout: 10000 });
    const contexts = browser.contexts();
    let page = null;
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        if (p.url().includes("127.0.0.1:9527")) page = p;
      }
      if (page) break;
    }

    const invoke = async (cmd, args = {}) => {
      return page.evaluate(async ({ cmd, args }) => {
        try {
          const result = await window.__TAURI_INTERNALS__.invoke(cmd, args);
          return { ok: true, result };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }, { cmd, args });
    };

    // 创建标签
    const r = await invoke("browser_create_tab", { id: "test-ipc", url: "https://www.example.com" });
    console.log("Create:", JSON.stringify(r));
    await page.waitForTimeout(5000);

    // 在子 WebView 中测试 __TAURI_INTERNALS__ 是否可用
    // 通过 CDP 找子页面
    const http = require("http");
    const targets = await new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:9300/json", (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
      }).on("error", reject);
    });
    console.log("CDP targets:", targets.map(t => t.url));

    // 找 example.com 页面
    let childPage = null;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes("example.com")) childPage = p;
      }
    }

    if (childPage) {
      console.log("Child page found:", childPage.url());

      // 测试 __TAURI_INTERNALS__ 是否存在
      const hasTauri = await childPage.evaluate(() => {
        return {
          hasInternals: !!window.__TAURI_INTERNALS__,
          hasInvoke: !!window.__TAURI_INTERNALS__?.invoke,
        };
      });
      console.log("Tauri internals in child WebView:", JSON.stringify(hasTauri));

      // 尝试调用 IPC
      if (hasTauri.hasInvoke) {
        const ipcResult = await childPage.evaluate(async () => {
          try {
            await window.__TAURI_INTERNALS__.invoke("browser_on_url_changed", {
              url: window.location.href
            });
            return "success";
          } catch (e) {
            return "error: " + String(e);
          }
        });
        console.log("IPC call from child WebView:", ipcResult);
      }
    } else {
      console.log("Child page not found in CDP");
    }

    // 清理
    await invoke("browser_close_tab", { id: "test-ipc" });
    console.log("\nDone");
  } catch (e) {
    console.error("ERROR:", e.message);
  }
  try { process.exit(0); } catch {}
})();
