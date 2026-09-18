# 垫片补偿可达性校验（Shim Reachability）

光学平台校准场景下的单页工具：A、B 两级垫片只能提供**离散的微米补偿值**，
需要判断每个目标厚度能否由 **A 级选一片 + B 级选一片** 相加得到。
页面由 React 单页构成，计算使用 TypeScript 精确求解（不使用固定响应或假接口），
Vite 负责构建，Vitest 保证算法精确性。

---

## 输入格式

在文本框粘贴一个 JSON 对象。根对象**必须且只能**包含 `a`、`b`、`targets` 三个字段：

| 字段      | 含义                | 元素个数       | 每个元素         |
| --------- | ------------------- | -------------- | ---------------- |
| `a`       | A 级垫片规格（μm）  | 1 – 100 000    | 整数 [0, 200000] |
| `b`       | B 级垫片规格（μm）  | 1 – 100 000    | 整数 [0, 200000] |
| `targets` | 待判定目标值（μm）  | 1 – 100 000    | 整数 [0, 400000] |

示例：

```json
{
  "a": [0, 3, 50, 200000],
  "b": [0, 1, 9, 100, 200000],
  "targets": [0, 1, 3, 4, 53, 300, 200000, 400000, 0]
}
```

规则与边界：

- **重复垫片值视为同一规格**：内部去重，不影响结果。
- **目标保留原始顺序和重复项**：结果数组与 `targets` 一一对应，重复目标给出相同结论。
- 每个目标只输出一个 `reachable` 布尔值（`true` = 存在 A 级片 x 与 B 级片 y 使 x+y=t）。
- 最大可判定和为 400000（200000 + 200000）；超过该值的目标恒为 `false`。
- 零值、最大边界值均正常参与计算。

### INVALID_INPUT

下列情况统一显示 **INVALID_INPUT**，并立即清除上一次的答案：

- 非法 JSON（语法错误、空输入）
- 根对象不是对象，或含有 `a`/`b`/`targets` 之外的额外字段，或缺少任一必需字段
- 任一字段不是数组
- 任一数组为空，或长度超过 100 000
- 元素不是整数（含浮点数、字符串、`null`、布尔、`NaN`、`Infinity`）
- 垫片值超出 [0, 200000]，或目标值超出 [0, 400000]

---

## 算法（禁止枚举全部数对）

朴素枚举 A×B 最多产生 100 000 × 100 000 = 10¹⁰ 个数对，会冻结浏览器。
求解器把每级垫片编码成一个以原生 **BigInt** 承载的位集（bitset）：

- `maskA`：第 x 位为 1 当且仅当 x ∈ A
- `revB`：第 (maxB − y) 位为 1 当且仅当 y ∈ B

对目标 t，将 `maskA` 平移后与 `revB` 按位与：

```
t ≤ maxB :  (maskA << (maxB - t)) & revB !== 0
t > maxB :  (maskA >> (t - maxB))     & revB !== 0
```

两个掩码在某位同时为 1，就等价于存在 x ∈ A 使 (t − x) ∈ B，即 t 可达。
整个过程是字级并行的位运算，**从不枚举任何数对**；
较窄的一侧作为被平移的掩码，重复目标通过缓存共享一次查询。

**性能**：满规模 100k × 100k、100k 个目标在普通设备上约 0.5 秒完成
（6 秒预算之内，见下文性能脚本）。计算运行在 Web Worker 中，页面不卡顿；
结果列表使用虚拟滚动，只渲染可视区域内的行。

---

## 本地开发

依赖：Node.js ≥ 20。

```bash
npm install        # 安装依赖
npm run dev        # 启动 Vite 开发服务器
npm test           # 运行 Vitest（一次性）
npm run test:watch # 测试监听模式
npm run build      # 类型检查 + 生产构建（输出到 dist/）
npm run preview    # 本地预览生产构建
npm run verify     # 一次性验收：tsc 类型检查 + 全部测试 + 生产构建
npm run perf       # 满规模 6 秒性能预算检查
```

---

## 测试策略（Vitest）

- **朴素小样本**：对若干小规模输入，与 O(|A|·|B|) 朴素枚举逐一比对，
  覆盖零值、最大边界、单边单值、乱序输入、重复规格、重复目标顺序一致性、A/B 对称性。
- **稠密集合**：连续区间、区间偏移（验证和集为连续区间）、区间 × 偶数散布，
  与朴素实现精确比对。
- **稀疏集合**：xorshift 确定性伪随机（可复现），中小规模与朴素实现全目标比对；
  满规模 100k × 100k 验证可复算性及 0 / 400000 边界结论。
- **输入校验**：非法 JSON、额外/缺失字段、空数组、超长数组、非整数、各类越界值。

---

## Docker / Docker Compose

多阶段 `Dockerfile` 提供三个阶段：构建（Vite）、`web`（nginx 托管静态文件）、
`verify`（一次性验收）。

### 启动静态 web 服务

```bash
docker compose up web --build        # 默认 http://localhost:8080
WEB_PORT=9090 docker compose up web  # 用 WEB_PORT 覆盖宿主/容器端口
```

`WEB_PORT`（默认 `8080`）由 nginx 官方镜像在启动时通过 `envsubst` 渲染
`/etc/nginx/templates/default.conf.template` 注入监听端口，同时用于宿主端口映射。

### 一次性验收服务 verify

`verify` 服务构建后运行一次 `npm run verify`（类型检查 → Vitest 精确性套件 →
生产构建），全部通过退出码才为 0：

```bash
docker compose run --rm verify
```

该服务配置在 `verify` profile 下，不会随 `docker compose up web` 启动，
是纯粹的一次性验收，不提供任何长期运行的接口。

---

## 项目结构

```
src/
  main.tsx                 # React 入口
  App.tsx                  # 单页界面（粘贴 JSON、状态、结果区）
  styles.css               # 页面样式
  solver.worker.ts         # Web Worker：解析 + 求解，避免阻塞 UI
  components/
    VirtualResults.tsx     # 结果虚拟列表（按原序，支持 10 万行）
  lib/
    validation.ts          # JSON 解析与边界校验（INVALID_INPUT）
    solver.ts              # BigInt 位集精确求解器
  solver.test.ts           # 朴素/稠密/稀疏精确性测试
  validation.test.ts       # 输入校验测试
scripts/
  perf-full.mjs            # 满规模 6 秒性能预算脚本
Dockerfile                 # build / verify / web 多阶段
docker-compose.yml         # web 服务 + verify 一次性服务
nginx/default.conf.template # 静态站点模板（${WEB_PORT} 占位）
```
