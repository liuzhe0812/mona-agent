import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import Home from "./app/page";
import Changelog from "./app/changelog/page";
import Tutorial from "./app/tutorial/page";
import "./app/globals.css";

// quick-start 在 Next.js 原生里是 redirect("/manual.html")
// 静态路由里直接用 Navigate 组件跳转到 manual.html（外部静态文件）
function QuickStartRedirect() {
  return <Navigate to="/manual.html" replace />;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/tutorial" element={<Tutorial />} />
        <Route path="/quick-start" element={<QuickStartRedirect />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
