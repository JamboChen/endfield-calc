# Endfield Calc — Production Chain Calculator for "Arknights: Endfield"

[中文](./README_zh.md)

[![Live Demo](https://img.shields.io/badge/🚀_Live_Demo-Try_Now-success?style=for-the-badge)](https://JamboChen.github.io/endfield-calc)
[![Discord](https://img.shields.io/badge/Discord-JOIN_US-5865F2?logo=discord&logoColor=white)](https://discord.gg/6V7CupPwb6)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Overview

**Endfield Calc** is a production chain calculator for **Arknights: Endfield** that helps players plan resource requirements, production ratios, and facility needs—including circular production loops.

## Key Features

### 🎯 Core Functionality
- **Multi-target planning** with automatic dependency resolution
- **Smart recipe selection** with circular dependency handling
- **Real-time calculation** of facility counts and power consumption
- **Manual raw material marking** for flexible supply chain control

### 📊 Dual View Modes

#### Table View
- Comprehensive production breakdown with all metrics
- **Interactive hover**: Highlight upstream dependencies on mouse hover

![Table View Interaction](./img/table-hover-demo.gif)

#### Dependency Tree View
Two visualization modes for different planning needs:

**Recipe View**: Aggregates facilities by recipe type, shows total requirements
- Best for overall recipe optimization and material flow overview

**Facility View**: Shows each individual facility as a separate node
- Best for detailed capacity planning and load balancing
- Displays capacity utilization and precise material allocation

![Tree Views](./img/tree-comparison.gif)

Both modes feature interactive flow diagrams, cycle visualization, and flow rate labels.

## Technology Stack

- **Framework**: React 18 + TypeScript + Vite
- **Visualization**: React Flow with Dagre layout
- **UI**: Radix UI + Tailwind CSS
- **i18n**: react-i18next

## Getting Started

### Try Online
Visit **[https://JamboChen.github.io/endfield-calc](https://JamboChen.github.io/endfield-calc)**

### Local Development
```bash
git clone https://github.com/JamboChen/endfield-calc.git
cd endfield-calc
pnpm install
pnpm run dev
```

### Docker

**Step 1: Build the image via GitHub Actions**

The image is hosted on GitHub Container Registry and must be built first. Go to your repository on GitHub:

> **Actions** → **Docker Build and Push** → **Run workflow**

This pushes the image to `ghcr.io/your_username/endfield-calc:latest`.

**Step 2: Run with Docker Compose**

Edit `compose.yaml` and replace the placeholder values:

```yaml
services:
  endfield-calc:
    image: ghcr.io/your_username/endfield-calc:latest
    ports:
      - "your_port:80"
    restart: unless-stopped
```

Then run:

```bash
docker compose up -d
```

**Build locally**

If you prefer to build the image on your own machine instead of using GitHub Actions:

```bash
git clone https://github.com/JamboChen/endfield-calc.git
cd endfield-calc
docker compose -f - up -d <<EOF
services:
  endfield-calc:
    build: .
    ports:
      - "your_port:80"
    restart: unless-stopped
EOF
```

Or edit `compose.yaml` to replace `image:` with `build: .` and run `docker compose up -d --build`.

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE)

---

**Note**: Fan-made tool, not officially affiliated with Arknights: Endfield.
