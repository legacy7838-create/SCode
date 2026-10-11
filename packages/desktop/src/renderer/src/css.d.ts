/**
 * 渲染端 side-effect CSS 导入的类型声明。
 *
 * 修复依据：把 `tsconfig.renderer.json` 纳入仓库的 `pnpm typecheck` 之后，
 * `main.tsx` 与 `resource-manager.tsx` 的 `import "@zcode/ui/styles.css"` 报
 * TS2882（Cannot find module or type declarations for side-effect import）。
 *
 * 根因不是缺少声明文件本身：`packages/ui/src/css.d.ts` 已经声明了 `*.css`。问题在于
 * 那是 ui 工程的 ambient declaration，而 desktop renderer 是**独立的 TypeScript project**
 * （`tsconfig.renderer.json` 通过 `references` 引用 ui）。project reference 只传递该工程
 * 产出的 `.d.ts` 输出，不会把源文件里的 ambient module 声明带进引用方的作用域，所以
 * `@zcode/ui/styles.css` 在 renderer 侧解析不到类型。
 *
 * 因此必须在 renderer 工程内自己声明一次。声明与打包器的真实行为一致：Vite 会把该导入
 * 交给 CSS 插件处理，TypeScript 只需要它不是一个错误即可。
 */
declare module "*.css";
