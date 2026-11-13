# 在容器中运行 DeepSeek Harness

[English](docker.md) | 中文

发布的镜像会在一个进程中启动开箱即用的 Harness，同时提供 Web UI 和一次性任务。它以非特权用户运行，把会话数据和工作区保存在具名卷上，并内置 Python 供代码执行。

## 镜像里有什么

- `dsh` 命令：Web UI 和一次性任务
- 持久化终端和命令执行
- Web 前端
- 用于文件操作的隔离沙箱
- Python 3 和 Python 代码执行后端
- 项目许可证和第三方声明

## 运行

镜像名以构建它的仓库为准（`ghcr.io/<仓库所有者>/deepseek-harness`）；以下示例使用 `agogo233` fork 发布的镜像。

```sh
docker run -d --name dsh -p 3080:3080 \
  -e DEEPSEEK_API_KEY=your-key \
  -v dsh-data:/data \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/agogo233/deepseek-harness:latest
```

Web UI 会打印一个带令牌的启动地址。纯安装路径见 [从 npm 运行](../../../README.zh.md#run)。

### 一次性任务

```sh
docker run --rm \
  -e DEEPSEEK_API_KEY=your-key \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/agogo233/deepseek-harness:latest \
  headless "Summarize this repository"
```

### docker compose

```yaml
# docker-compose.yml
services:
  dsh:
    image: ghcr.io/agogo233/deepseek-harness:latest
    ports: ["3080:3080"]
    environment:
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
    volumes:
      - dsh-data:/data
      - ./workspace:/workspace
volumes:
  dsh-data:
```

```sh
docker compose up -d
```

## 从局域网访问

仅端口映射就足够了；本地使用不需要反向代理。需要告诉进程浏览器使用的地址，否则 API 会拒绝请求：

```sh
docker run -d --name dsh -p 3080:3080 \
  -e DEEPSEEK_API_KEY=your-key \
  -e DSH_PUBLIC_URL=http://192.168.1.10:3080/ \
  -e DSH_TRUSTED_HOSTS=192.168.1.10 \
  -v dsh-data:/data \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/agogo233/deepseek-harness:latest
```

`DSH_PUBLIC_URL` 只改变启动行中打印的地址。`DSH_TRUSTED_HOSTS` 才是真正允许该地址访问 API 的设置，每个条目一个主机或 主机:端口。

## 认证

每个请求都需要凭据，而且没有用户名或密码。

- 启动行携带一次性令牌。打开它，浏览器会收到一个签名 Cookie，对该地址有效 30 天。
- 之后，Cookie 会为每个页面请求和实时调用完成认证。
- 分享启动行即分享访问权限。清除 Cookie 只结束一个浏览器会话。
- 重启会改变令牌；重启前签发的 Cookie 在过期前继续有效。
- 要让所有人退出，请删除数据卷中的凭据文件并重启。

## 在反向代理之后发布

对外访问时，需要在前面放一个反向代理：它负责 TLS、主机名和额外的认证层。内置的令牌和 Cookie 单独在开放互联网上是不够的。

参见 [在反向代理之后发布 Web UI](./public-deployments.zh.md)，了解代理必须做什么：保留面向浏览器的主机、剥离挂载前缀、转发升级请求、重写 Cookie 范围，并重定向裸挂载地址。把同地址传给进程：

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

在镜像中设置：

```sh
DSH_PUBLIC_URL=https://app.example/ui/
DSH_TRUSTED_HOSTS=app.example
```

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | | 模型 API 密钥 |
| `DSH_PUBLIC_URL` | `http://localhost:3080/` | 启动行中打印的地址 |
| `DSH_TRUSTED_HOSTS` | | API 接受的 authority，空格分隔 |
| `DSH_BIND_HOST` | 容器 IPv4 | 监听器绑定的地址 |
| `DSH_PORT` | `3080` | 监听器端口 |
| `DSH_HOME` | `/data/dsh` | 会话和凭据存储 |
| `DSH_AGENTS_HOME` | `/data/agents` | Agent 备注 |
| `DSH_TELEMETRY_DISABLED` | `1` | 使用数据上报默认关闭 |

## 数据

- `/data/dsh` 保存会话、凭据和设置。
- `/workspace` 是 Agent 读取和编辑的工作区。
- 两者都是卷，因此数据在重启后保留，删除卷时被清除。

## Python

内置 Python 3 供代码执行。Web UI 和一次性任务默认使用内置后端；Python 后端是实验性的，需要显式组合才能启用。
