/**
 * three ESM 源码文本，用于注入沙箱 iframe。
 *
 * three 的 exports map 未暴露 build/ 深路径，用相对路径 + Vite ?raw
 * 在构建时内联，随 Mona 本地打包，运行时零网络请求。
 * r167+ 拆分为 module + core 两个文件，沙箱内会重写 core 的相对引用。
 * OrbitControls 仅依赖裸标识符 "three"，由沙箱 import map 解析。
 */
import threeCoreSource from "../../../../node_modules/three/build/three.core.min.js?raw";
import threeModuleSource from "../../../../node_modules/three/build/three.module.min.js?raw";
import orbitControlsSource from "../../../../node_modules/three/examples/jsm/controls/OrbitControls.js?raw";

export { threeCoreSource, threeModuleSource, orbitControlsSource };
