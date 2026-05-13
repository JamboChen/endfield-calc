````markdown
# Endfield Calc — 《明日方舟：终末地》生产计算器

[English](./README.md)

[![在线体验](https://img.shields.io/badge/🚀_在线体验-立即使用-success?style=for-the-badge)](https://JamboChen.github.io/endfield-calc)
[![Discord](https://img.shields.io/badge/Discord-加入社区-5865F2?logo=discord&logoColor=white)](https://discord.gg/6V7CupPwb6)
[![许可证](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 概述

**Endfield Calc** 是一款针对 **《明日方舟：终末地》** 的生产链计算工具。  
可帮助玩家规划资源需求、生产配比和设施数量，支持处理循环生产链。

## 核心功能

### 🎯 生产规划
- **多目标规划**：支持同时设置多个生产目标  
- **自动依赖解析**：递归计算中间产物与原料  
- **实时计算**：修改目标或配方后立即更新结果  
- **手动原料标记**：灵活控制供应链  

### 📊 双视图模式

#### 表格视图
- 全面展示生产细节与指标  
- **交互高亮**：鼠标悬停显示上游依赖  

![Table View Interaction](./img/table-hover-demo.gif)

#### 依赖树视图
**配方视图**：按配方类型汇总设施数量  
- 适合整体优化和物料流概览  

**设施视图**：显示每个设施节点  
- 适合详细规划产能和负载平衡  
- 显示容量利用率和物料分配  

![Tree Views](./img/tree-comparison.gif)

两种模式均支持交互式流程图、循环可视化及流量标注。

## 技术栈

- **框架**：React 18 + TypeScript + Vite  
- **可视化**：React Flow + Dagre 布局  
- **UI**：Radix UI + Tailwind CSS  
- **国际化**：react-i18next  

## 快速开始

### 在线体验
访问 [https://JamboChen.github.io/endfield-calc](https://JamboChen.github.io/endfield-calc)

### 本地开发
```bash
git clone https://github.com/JamboChen/endfield-calc.git
cd endfield-calc
pnpm install
pnpm run dev
```

### Docker

**第一步：通过 GitHub Actions 构建镜像**

镜像托管在 GitHub Container Registry，需先触发构建。在 GitHub 仓库页面操作：

> **Actions** → **Docker Build and Push** → **Run workflow**

构建完成后镜像会推送至 `ghcr.io/your_username/endfield-calc:latest`。

**第二步：使用 Docker Compose 运行**

编辑 `compose.yaml`，替换其中的占位符：

```yaml
services:
  endfield-calc:
    image: ghcr.io/your_username/endfield-calc:latest
    ports:
      - "your_port:80"
    restart: unless-stopped
```

然后运行：

```bash
docker compose up -d
```


**本地构建镜像**

如果不想使用 GitHub Actions，也可以在本地直接构建：

将 `compose.yaml` 中的 `image:` 替换为 `build: .`：

```yaml
services:
  endfield-calc:
    build: .
    ports:
      - "your_port:80"
    restart: unless-stopped
```

然后运行：

```bash
docker compose up -d --build
```

欢迎任何形式的贡献！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详细规范。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。

---

**说明**：本工具为玩家自制项目，与《明日方舟：终末地》官方无任何隶属或合作关系。
