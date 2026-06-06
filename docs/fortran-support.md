# Fortran 语言支持 — 实现记录

## 概述

为 CodeGraph 添加了 Fortran 语言支持，覆盖自由格式 Fortran 90+（`.f90`/`.f95`/`.f03`/`.f08`）和固定格式 F77（`.f`/`.for`/`.ftn`）。经过对 TLUSTY/SYNSPEC 天体物理代码的实战验证。

## 实现步骤

### 1. 获取 grammar WASM

使用 `@lumis-sh/wasm-fortran` (ABI 15)，从上游 `stadelmanma/tree-sitter-fortran` 最新源码重新编译为 WASM。

```bash
npm pack @lumis-sh/wasm-fortran
tar xzf lumis-sh-wasm-fortran-*.tgz -C /tmp/
cp /tmp/package/tree-sitter-fortran.wasm src/extraction/wasm/

# 如需从源码重建（需要 Docker + emscripten）：
git clone https://github.com/stadelmanma/tree-sitter-fortran.git --depth 1
cd tree-sitter-fortran
sed -i 's/"tree-sitter": "==0.26.0"/"tree-sitter": "^0.25.0"/' package.json
npm install && npm install tree-sitter-cli@0.24.5 --save-dev
npx tree-sitter build --wasm
cp tree-sitter-fortran.wasm src/extraction/wasm/
```

### 2. 接线（4个文件）

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `LANGUAGES` 数组加 `'fortran'` |
| `src/extraction/grammars.ts` | `WASM_GRAMMAR_FILES`、`EXTENSION_MAP`（15个扩展名）、`getLanguageDisplayName`、vendored 分支 |
| `src/extraction/languages/index.ts` | 导入 + 注册 `fortranExtractor` |
| `src/extraction/languages/fortran.ts` | **新文件**，提取器本体 |

### 3. 提取器设计（Fortran 特殊性）

| 问题 | 解决方案 |
|------|---------|
| grammar 字段名不一致 | `resolveName` 按 node type 查找（`module_statement` 无 field，`function_statement` 有 field） |
| F77 `C`/`c`/`*` 注释不识别 | `preprocessSource` 在源码层面转为 `!` |
| 一个声明多个变量 | `extractVariables` 按 declarator 类型分别处理 |
| `use_statement` 的 `module_name` 是未命名子节点 | 按 node type 查找 |
| `visitFunctionBody` 重入递归 | `resolveBody` + `WeakSet` 守卫 |

### 4. 通用代码修复（3处）

| 文件 | 问题 | 修复 |
|------|------|------|
| `src/extraction/tree-sitter.ts` | `extractCall` 缺 `filePath`/`language` | 填充字段，支持 name-matcher 消歧 |
| `src/resolution/index.ts` | `hasAnyPossibleMatch` 大小写敏感 | 加 `.toLowerCase()`/`.toUpperCase()` |
| `src/extraction/index.ts` | `MAX_FILE_SIZE` 1MB 不够大文件 | 改为 5MB |

### 5. 测试结果

- 7 个 Fortran 提取测试全部通过
- 全量 1135 测试通过，0 回归

### 6. 实战验证（TLUSTY/SYNSPEC）

| 指标 | 数值 |
|------|------|
| 索引文件 | 2 个（`tlusty208.f` 1.6MB + `synspec54.f` 801KB） |
| 函数/子程序 | 403 个 |
| 调用边 | 1309 条 |
| 命名 caller 占比 | 98.3% |
| 匿名调用 | 22 条（1.7%，grammar 对 F77 表达式解析的硬限制） |

## 在其他设备上重现

### 前提条件

- Node.js >= 20
- （如需从源码编译 grammar）Docker + emscripten，或 GLIBC >= 2.39

### 步骤

```bash
# 1. 克隆仓库
git clone https://github.com/Asfmq/codegraph.git
cd codegraph

# 2. 安装依赖
npm ci

# 3. 构建（自动复制 WASM 到 dist/）
npm run build

# 4. 验证 Fortran 提取
npx vitest run __tests__/extraction.test.ts -t "Fortran"

# 5. 索引一个 Fortran 项目
cd /path/to/fortran-project
node /path/to/codegraph/dist/bin/codegraph.js init -i

# 6. 检查结果
sqlite3 .codegraph/codegraph.db \
  "SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY COUNT(*) DESC;"
```

### 重编译 grammar WASM（如果需要）

```bash
cd /path/to/codegraph
npm install tree-sitter-cli@0.24.5 --save-dev

git clone https://github.com/stadelmanma/tree-sitter-fortran.git --depth 1 /tmp/ts-fortran
cd /tmp/ts-fortran
sed -i 's/"tree-sitter": "==0.26.0"/"tree-sitter": "^0.25.0"/' package.json
npm install

# 本地 GLIBC >= 2.39 时直接构建
npx tree-sitter build --wasm

# 或用 Docker（任何平台）
docker run --rm -v $(pwd):/src -w /src emscripten/emsdk:3.1.64 \
  bash -c "npm install -g tree-sitter-cli && npx tree-sitter generate && npx tree-sitter build --wasm"

cp tree-sitter-fortran.wasm /path/to/codegraph/src/extraction/wasm/
cd /path/to/codegraph && npm run build && npx vitest run
```

## 已知限制

1. **F77 固定格式**：`C`/`c`/`*` 注释通过 `preprocessSource` 转为 `!` 解决，但 HOLLITH 常量、语句函数等 F77 特性仍有解析不完整的情况
2. **匿名调用 22 条 (1.7%)**：来自 F77 表达式复杂区域的 grammar ERROR，需要上游改进 scanner.c
3. **grammar 不认 F77 注释**：上游 scanner.c 修改尝试失败（与 grammar token 协议冲突），`preprocessSource` 是正确方案
