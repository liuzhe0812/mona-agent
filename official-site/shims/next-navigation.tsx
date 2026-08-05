// Shim for next/navigation in static build -> react-router equivalents
// redirect() 在静态 SPA 里不立即执行（避免 import 时触发跳转）
// 路由跳转由 static-main.tsx 里的 <Navigate> 组件处理
export function redirect(_path: string) {
  // no-op: 路由级跳转由 react-router <Navigate> 处理
}
