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

    // 创建标签
    console.log("\n=== Test 1: Create tab ===");
    const createResult = await invoke("browser_create_tab", { id: "test-full", url: "https://www.example.com" });
    console.log("Result:", JSON.stringify(createResult));
    results.create_tab = createResult.ok;
    await page.waitForTimeout(5000);

    // 设置 WebView 大小
    await page.evaluate(async () => {
      const webviewMod = await import("/node_modules/.vite/deps/@tauri-apps_api_webview.js");
      const dpiMod = await import("/node_modules/.vite/deps/@tauri-apps_api_dpi.js");
      const webview = await webviewMod.Webview.getByLabel("browser-test-full");
      if (webview) {
        await webview.setPosition(new dpiMod.LogicalPosition(0, 0));
        await webview.setSize(new dpiMod.LogicalSize(1200, 800));
      }
    });

    // 找子页面
    await page.waitForTimeout(3000);
    let childPage = null;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes("example.com")) childPage = p;
      }
    }

    if (childPage) {
      console.log("Child page:", childPage.url());

      // 测试 2: browser_navigate_tab IPC
      console.log("\n=== Test 2: browser_navigate_tab IPC ===");
      const navResult = await invoke("browser_navigate_tab", { id: "test-full", url: "https://www.baidu.com" });
      console.log("Navigate result:", JSON.stringify(navResult));
      await page.waitForTimeout(5000);
      console.log("After navigate URL:", childPage.url());
      results.navigate_ipc = childPage.url().includes("baidu.com");

      // 回到 example.com
      await invoke("browser_navigate_tab", { id: "test-full", url: "https://www.example.com" });
      await page.waitForTimeout(3000);

      // 测试 3: target="_blank" 链接点击（initialization_script 拦截）
      console.log("\n=== Test 3: target=_blank link click ===");
      await childPage.evaluate(() => {
        const link = document.createElement('a');
        link.href = 'https://www.bing.com';
        link.target = '_blank';
        link.textContent = 'Test _blank';
        link.id = 'test-blank-link';
        link.style.cssText = 'position:fixed;top:50%;left:50%;font-size:24px;z-index:99999;background:yellow;padding:20px;';
        document.body.appendChild(link);
      });

      await childPage.click('#test-blank-link');
      console.log("Clicked target=_blank, waiting...");
      await page.waitForTimeout(8000);
      console.log("After click URL:", childPage.url());
      results.blank_link = childPage.url().includes("bing.com");

      // 测试 4: 同页面链接（无 target）
      console.log("\n=== Test 4: Same-page link ===");
      await invoke("browser_navigate_tab", { id: "test-full", url: "https://www.example.com" });
      await page.waitForTimeout(3000);
      // 重新找子页面
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          if (p.url().includes("example.com")) childPage = p;
        }
      }
      if (childPage) {
        await childPage.evaluate(() => {
          const link2 = document.createElement('a');
          link2.href = 'https://www.bing.com';
          link2.textContent = 'Same page';
          link2.id = 'test-same-link';
          link2.style.cssText = 'position:fixed;top:70%;left:50%;font-size:24px;z-index:99999;background:lime;padding:20px;';
          document.body.appendChild(link2);
        });
        await childPage.click('#test-same-link');
        await page.waitForTimeout(5000);
        console.log("After same-page link URL:", childPage.url());
        results.same_page_link = childPage.url().includes("bing.com");
      }
    } else {
      console.log("Child page not found");
    }

    // 测试 5: Ctrl+A
    console.log("\n=== Test 5: Ctrl+A ===");
    await page.bringToFront();
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = 'hello world test'; input.id = 'test-ctrl-a';
      input.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;width:300px;height:30px;';
      document.body.appendChild(input);
    });
    await page.click('#test-ctrl-a');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(100);
    const selResult = await page.evaluate(() => {
      const input = document.getElementById('test-ctrl-a');
      return { allSelected: input.selectionStart === 0 && input.selectionEnd === input.value.length };
    });
    results.ctrl_a = selResult.allSelected;

    // 清理
    await page.evaluate(() => {
      const el = document.getElementById('test-ctrl-a');
      if (el) el.remove();
    });
    await invoke("browser_close_tab", { id: "test-full" });

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
