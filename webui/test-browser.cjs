const { chromium } = require("playwright");
(async () => {
  const results = {};
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
    console.log("Main page:", page.url());

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

    // === Test 1: 创建两个标签 ===
    console.log("\n=== Test 1: Create two tabs ===");
    const r1 = await invoke("browser_create_tab", { id: "tab-a", url: "https://www.example.com" });
    const r2 = await invoke("browser_create_tab", { id: "tab-b", url: "https://www.bing.com" });
    console.log("Tab A:", JSON.stringify(r1), "Tab B:", JSON.stringify(r2));
    results.create_two_tabs = r1.ok && r2.ok;
    await page.waitForTimeout(5000);

    // === Test 2: 导航 tab-a ===
    console.log("\n=== Test 2: Navigate tab-a ===");
    const nav = await invoke("browser_navigate_tab", { id: "tab-a", url: "https://www.baidu.com" });
    console.log("Navigate:", JSON.stringify(nav));
    results.navigate = nav.ok;
    await page.waitForTimeout(3000);

    // === Test 3: 后退 ===
    console.log("\n=== Test 3: Go back ===");
    const back = await invoke("browser_go_back", { id: "tab-a" });
    console.log("Go back:", JSON.stringify(back));
    results.go_back = back.ok;
    await page.waitForTimeout(3000);

    // === Test 4: 前进 ===
    console.log("\n=== Test 4: Go forward ===");
    const fwd = await invoke("browser_go_forward", { id: "tab-a" });
    console.log("Go forward:", JSON.stringify(fwd));
    results.go_forward = fwd.ok;
    await page.waitForTimeout(3000);

    // === Test 5: URL 变化通知 ===
    console.log("\n=== Test 5: URL change notification ===");
    // 注册事件监听
    const eventSetup = await page.evaluate(async () => {
      window.__testUrlChanges = [];
      const { listen } = await import("/node_modules/.vite/deps/@tauri-apps_api_event.js");
      window.__testUrlUnlisten = await listen("browser-url-changed", (event) => {
        window.__testUrlChanges.push(event.payload);
      });
      return true;
    });
    console.log("Event listener setup:", eventSetup);

    // 导航触发 URL 变化
    await invoke("browser_navigate_tab", { id: "tab-a", url: "https://www.bing.com" });
    await page.waitForTimeout(5000);

    // 检查是否收到 URL 变化事件
    const urlChanges = await page.evaluate(() => window.__testUrlChanges);
    console.log("URL changes received:", JSON.stringify(urlChanges));
    results.url_change_event = urlChanges.length > 0;

    // === Test 6: 列出标签验证 URL 更新 ===
    console.log("\n=== Test 6: List tabs ===");
    const list = await invoke("browser_list_tabs");
    console.log("Tabs:", JSON.stringify(list.result, null, 2));
    const tabA = list.result?.find(t => t.id === "tab-a");
    results.url_updated_in_state = tabA?.url?.includes("bing.com") ?? false;

    // 清理
    await page.evaluate(() => {
      if (window.__testUrlUnlisten) window.__testUrlUnlisten();
    });
    await invoke("browser_close_tab", { id: "tab-a" });
    await invoke("browser_close_tab", { id: "tab-b" });

    console.log("\n========== RESULTS ==========");
    for (const [k, v] of Object.entries(results)) {
      const status = v === true ? "PASS" : v === false ? "FAIL" : String(v);
      console.log(`  ${k}: ${status}`);
    }
    console.log("==============================");
  } catch (e) {
    console.error("ERROR:", e.message);
  }
  try { process.exit(0); } catch {}
})();
