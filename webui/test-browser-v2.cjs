const { chromium } = require("playwright");
(async () => {
  const results = {};
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9300", { timeout: 15000 });
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

    // === Test 1: 创建标签 ===
    console.log("\n=== Test 1: Create tab ===");
    const r1 = await invoke("browser_create_tab", { id: "test-tab1", url: "https://www.example.com" });
    console.log("Tab 1:", JSON.stringify(r1));
    results.create_tab = r1.ok;
    await page.waitForTimeout(5000);

    // === Test 2: on_navigation 触发 URL 变化事件 ===
    console.log("\n=== Test 2: on_navigation URL change event ===");
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

    // 导航触发 URL 变化（on_navigation 应该触发 browser-url-changed 事件）
    await invoke("browser_navigate_tab", { id: "test-tab1", url: "https://www.bing.com" });
    await page.waitForTimeout(5000);

    // 检查是否收到 URL 变化事件
    const urlChanges = await page.evaluate(() => window.__testUrlChanges);
    console.log("URL changes received:", JSON.stringify(urlChanges, null, 2));
    results.url_change_event = urlChanges.some(c => c.id === "test-tab1" && c.url?.includes("bing.com"));

    // === Test 3: 列出标签验证 URL 更新 ===
    console.log("\n=== Test 3: List tabs ===");
    const list = await invoke("browser_list_tabs");
    console.log("Tabs:", JSON.stringify(list.result, null, 2));
    const tab1 = list.result?.find(t => t.id === "test-tab1");
    results.url_updated_in_state = tab1?.url?.includes("bing.com") ?? false;

    // === Test 4: 后退 ===
    console.log("\n=== Test 4: Go back ===");
    const back = await invoke("browser_go_back", { id: "test-tab1" });
    console.log("Go back:", JSON.stringify(back));
    results.go_back = back.ok;
    await page.waitForTimeout(3000);

    // 检查后退后 URL 变化事件
    const urlChangesAfterBack = await page.evaluate(() => window.__testUrlChanges);
    console.log("URL changes after back:", JSON.stringify(urlChangesAfterBack, null, 2));
    results.url_change_on_back = urlChangesAfterBack.some(c => c.id === "test-tab1" && c.url?.includes("example.com"));

    // === Test 5: 前进 ===
    console.log("\n=== Test 5: Go forward ===");
    const fwd = await invoke("browser_go_forward", { id: "test-tab1" });
    console.log("Go forward:", JSON.stringify(fwd));
    results.go_forward = fwd.ok;
    await page.waitForTimeout(3000);

    // === Test 6: 创建第二个标签（切换 tab 测试）===
    console.log("\n=== Test 6: Create second tab ===");
    const r2 = await invoke("browser_create_tab", { id: "test-tab2", url: "https://www.baidu.com" });
    console.log("Tab 2:", JSON.stringify(r2));
    results.create_second_tab = r2.ok;
    await page.waitForTimeout(3000);

    // === Test 7: 刷新 ===
    console.log("\n=== Test 7: Reload ===");
    const reload = await invoke("browser_reload", { id: "test-tab1" });
    console.log("Reload:", JSON.stringify(reload));
    results.reload = reload.ok;

    // 清理
    await page.evaluate(() => {
      if (window.__testUrlUnlisten) window.__testUrlUnlisten();
    });
    await invoke("browser_close_tab", { id: "test-tab1" });
    await invoke("browser_close_tab", { id: "test-tab2" });

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
