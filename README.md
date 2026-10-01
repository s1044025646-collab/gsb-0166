# 晶格粉末衍射峰与系统消光分析后端

仅限**正交晶胞**、点原子、常数实散射因子的**运动学理想**粉末衍射计算。
强度仅为结构因子模方 `|F|^2`，**不**包含仪器展宽、吸收、温度（Debye–Waller）
等真实实验效应；也不做质谱匹配、不连接任何材料数据库。晶体均为虚构夹具。

运行时使用 Node 内置的 `node:sqlite` 与原生 TypeScript 支持，**零第三方依赖**
（无需 `npm install`）。需要 Node.js **>= 22.5**（开发环境为 Node 25）。

## 物理模型

- 晶面间距（倒易长度，绝非最近原子距离）：
  `1/d^2 = (h/a)^2 + (k/b)^2 + (l/c)^2`
- Bragg 二倍角：`sin(theta) = lambda/(2d)`，`2theta = 2*asin(...)`（度）。
- 复结构因子：`F = sum_j f_j * occ_j * exp(i * 2*pi*(h*x_j + k*y_j + l*z_j))`，
  原子相位直接来自分数坐标。
- 单反射强度 `I(hkl) = |F|^2`。
- 粉末线把**相同 d** 的单反射合并：`multiplicity` = 合并反射个数，
  粉末线强度 = 各单反射 `|F|^2` 之**和**；合并后**不再**乘多重性。
- 简单立方 / 体心（h+k+l 奇偶）/ 面心（指数奇偶混合）的消光规则完全由结构
  因子自然相消产生，代码中没有任何按指数删峰的硬编码。
- 公开容差 `EPS = 1e-9`（见 `src/physics.ts`）；`|F|^2 < EPS` 判定为消光，
  输出保留浮点全精度、不截断。

`(000)` 作为前向光单独以 `ZERO_INDEX` 排除；`lambda/(2d) > 1` 以
`WAVELENGTH_NOT_DIFFRACTABLE` 排除并说明原因；角度窗口外的以 `OUTSIDE_WINDOW`
记录（窗口边界包含）。非法晶胞长度、波长、坐标、占有率和指数范围在参数校验层
拒绝。所有报告都标注米勒指数截断范围与参数快照，并明确这是**有限枚举**而非
全部反射。

## 目录

- `src/physics.ts` — 纯物理：校验、枚举、d/2θ/复结构因子、粉末合并、消光解释。
- `src/db.ts` — SQLite 持久化：可重复迁移、建晶胞事务、幂等扫描、重启持久化。
- `src/server.ts` — 仅绑定 `127.0.0.1`、端口 0 自动分配的 HTTP API。
- `src/cli.ts` — 命令行（关键操作打印 before/after 状态）。
- `src/fixtures.ts` — 虚构晶体：单原子 SC、BCC、FCC、不同 f、分数平移。
- `src/demo.ts` — 可重复端到端演示（注入固定时钟与固定幂等键）。
- `test/` — `node:test` 自动化测试（物理、失败路径、事务回滚、重启、HTTP）。
- 所有数据库、临时文件和报告都写在项目内的 `data/`。

## 依赖

无需安装第三方包。仅需 Node.js >= 22.5。

## 测试

```powershell
npm test
```

覆盖：手算低指数 d/2θ/`|F|^2`、倒易长度、BCC/FCC 系统消光、不同散射因子打破
消光、整胞分数平移不变、Friedel 对称、合并强度守恒与多重性只计一次、零指数/
波长/窗口排除原因、非法参数失败路径、事务回滚、迁移幂等、重复扫描幂等、注入
时钟、重启后持久化，以及 HTTP 分页与错误码。

## 端到端演示

```powershell
npm run demo
```

生成 `data/demo-report.txt` 与 `data/demo-peaks.csv`，内容在固定时钟下可重复。

## 启动 / 停止 API（仅本机、自动端口）

```powershell
npm start                 # 前台运行，打印 http://127.0.0.1:<自动端口> 与 pid
# 或后台方式（写入 data/server.json，含端口和 pid）：
node --no-warnings src/cli.ts server:start
node --no-warnings src/cli.ts server:stop   # 等价于 npm run stop
```

停止只针对本项目记录在 `data/server.json` 的 pid，不管理其它进程。

### HTTP 接口

- `GET /health`
- `POST /cells`：`{a,b,c,atoms:[{label,x,y,z,f,occ}]}`
- `GET /cells?limit=&offset=` / `GET /cells/:id`
- `POST /cells/:id/scans`（可带 `Idempotency-Key` 头或 `requestId` 字段）
- `GET /scans?cellId=&limit=&offset=` / `GET /scans/:id?kind=reflections|excluded|lines&limit=&offset=`
- `GET /scans/:id/explain?h=&k=&l=`

错误码：`INVALID_PARAMS`(400)、`INVALID_JSON`(400)、`INVALID_QUERY`(400)、
`NOT_FOUND`(404)、`INTERNAL`(500)。列表统一返回 `{data,page:{limit,offset,total}}`。

## CLI

```powershell
node --no-warnings src/cli.ts cell:create --fixture simpleCubic|bodyCentred|faceCentred|mixedScatter [--a 3] [--translate --tx .25 --ty .25 --tz .25]
node --no-warnings src/cli.ts cell:list
node --no-warnings src/cli.ts scan:run --cell 1 [--wavelength 1.5406 --hmin -3 --hmax 3 --tmin 0 --tmax 180 --report 1] [--request-id ID]
node --no-warnings src/cli.ts reflection:trace --scan 1 --h 1 --k 1 --l 0
node --no-warnings src/cli.ts extinction:explain --scan 1 --h 1 --k 0 --l 0
node --no-warnings src/cli.ts occupancy:compare --cell 1 --label M2 --occ 0.5 [--scan 1]
node --no-warnings src/cli.ts peaks:export --scan 1 [--out data/peaks.csv]
```

CLI 默认使用 `data/app.db`，可用 `--db <path>` 指定其它项目内数据库。

## 清理

删除 `data/` 即清除本项目的全部数据库、临时文件、报告和服务器标记；不会触及
项目之外的任何文件或进程。
