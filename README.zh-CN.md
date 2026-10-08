# 适用于 Chromium 的 Firefox IP 保护桥接

[English](README.md) | **中文**

一个**非官方**的 Chromium 扩展（Chrome、Edge、Brave）：通过本地 Native Messaging
+ SOCKS5 桥接，让具备 Firefox IP 保护资格的 Mozilla 账号在 Chromium 浏览器中使用该
服务。

本项目与 Mozilla、Google、Fastly 及文中提到的任何其他方均无隶属、背书或支持关系。
参见[免责声明](#免责声明)。

> **本仓库只包含源码。** 其中刻意不含凭据、不含已安装的运行时、不含二进制文件。
> 因此一次可用的安装除了扩展之外，还需要在本地构建出的运行时；参见[安装](#安装)。

## 它做什么

Firefox IP 保护是 Mozilla VPN 的一项功能，把浏览器流量经由 Fastly 运营的出口转发。
本桥接让 Chromium 浏览器复用符合条件的账号会话：

- 扩展负责浏览器一侧：开关、地区选择、按网站分流。
- 本地 Native Messaging 宿主负责账号一侧：获取并续期会话凭据，并运行本地 SOCKS5
  监听。
- Chromium 通过作用域限定在路由上的 PAC 脚本指向该监听，因此只有你选择走 VPN 的流量
  会受影响。

原始账号会话令牌绝不会回传给扩展页面或 `chrome.storage`，它只保存在单独安装的本地
运行时中。

## 功能

### 凭据

- **浏览器登录（1.1.0，推荐）。** 直接在扩展弹窗内登录 Mozilla 账号。无需安装桌面
  Firefox，此后也不再需要 Firefox 运行。
- **从 Firefox 导入（可选替代路径）。** 读取本机 Firefox 配置中已登录的账号。此路径
  需要已安装桌面 Firefox 并已登录。
- **自动续期。** 两条路径任一生效后，凭据都会在后台通过纯 HTTP 续期。账号首次使用
  IP 保护时会自动创建 Guardian 注册。

### 路由

- 一键开启/关闭 VPN。
- 选择出口地区，或交由桥接推荐。推荐按实测延迟排序，并跳过出口国家不固定的共享
  anycast 出口，因此界面显示的地区就是你实际得到的地区。
- 两种按网站分流模式，均通过作用域限定在路由上的 PAC 脚本生效：
  - **白名单** —— 只有你列出的网站走 VPN，其余保持直连。
  - **黑名单** —— 除你列出的网站外都走 VPN。
- 针对当前所在页面的单独开关。
- 规则导出/导入，便于在浏览器与 Chrome 配置文件之间迁移规则（`chrome.storage.local`
  不会同步）。

### 隐私控制

- **WebRTC 防泄漏** —— 阻止 WebRTC 绕过代理暴露真实 IP；VPN 关闭时也可以继续保护。
- **DNS 预解析防护** —— 只对实际走 VPN 的页面关闭 DNS 预解析；直连页面
  保留 Chromium 原本的预解析与预连接加速。
- **区域隐私保护** —— 让语言、时区、上报位置与出口地区对齐，并遮罩中文字体探测。仅对
  实际走 VPN 的网站生效。

### 账号

- 查询本月套餐、已用流量、剩余流量与重置时间。

### 运维

- **可移动安装。** 本地组件固定在每用户目录
  （`%LOCALAPPDATA%\FirefoxChromeVPNBridge`），因此移动或重命名未打包扩展目录不会
  破坏 Native Messaging。
- **命令审计日志**位于 `runtime\logs\bridge.log`，登录详情日志位于
  `runtime\logs\bootstrap-login.log`。两者只记录命令名、结果与非敏感错误文本，绝不
  记录密码或验证码。

## 环境要求

- **Windows 64 位。** 本地宿主仅支持 Windows。
- **Chromium 浏览器** 120 或更高版本（Chrome、Edge 或 Brave）。
- **已安装的 64 位 Python 3.14** —— 源码检出需要你自行准备；打包的安装脚本会查找
  已有安装，不修改 `PATH`、不创建 Windows 服务、不创建开机启动项。
- **具备资格的 Mozilla 账号**，可用 Firefox IP 保护。资格与服务条款由你与 Mozilla
  之间确认。
- **仅浏览器登录所需的可选组件：** Playwright 及其 Firefox 构建（约 80 MB）。发行包
  的安装脚本会自动装入本地运行时；源码检出需要你自行安装。缺少时只有"浏览器登录"
  按钮不可用，其他功能不受影响，之后可重跑安装脚本补装。

## 安装

有两条路径可以得到可用的安装。两者都源自同一份代码，区别只在于由谁构建运行时。

### 方式一 —— 一键整合包（推荐）

从 [Releases](../../releases) 页面下载 `Firefox-IP-Protection-Bridge-<版本>.zip`，解压到任意
目录，双击 **`INSTALL-OR-REPAIR.cmd`**。脚本会依次：

1. 查找 Python 3.9 或更新版本；若一个都没有，会提议用 `winget` 自动安装；
2. 把运行时复制到 `%LOCALAPPDATA%\FirefoxChromeVPNBridge`；
3. 安装桥接所需的 Python 依赖；
4. 下载浏览器登录组件（约 80 MB；加 `-SkipBrowserLogin` 可跳过，之后重跑即可补装）；
5. 写入 Native Messaging 清单，并为 Chrome、Edge、Chromium 和 Brave 注册。

可以放心重复运行：第二次运行等于修复或升级既有安装。

随后脚本会打印唯一无法自动化的一步——加载整合包内 `extension` 目录里的未打包扩展：

1. 打开 `chrome://extensions`。
2. 打开右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择该 `extension` 目录。
4. 打开弹窗，展开**设置**，点击**浏览器登录**。

### 方式二 —— 从源码检出开始

同一个脚本也能在 git 检出里使用。它需要一个已冻结的桥接可执行文件——Chrome 按可执行
文件路径启动本地宿主，无法直接运行 `.py` 文件；原因详见 [`docs/BUILD.md`](docs/BUILD.md)。

1. **取得可执行文件。** 要么从 Releases 页面把 `vpn_bridge_host.exe` 与
   `bridge-build.json` 下载到 `dist\`，要么自行构建：
   `python -m PyInstaller --noconfirm --clean --distpath dist --workpath build tools/bridge-rebuild/vpn_bridge_host.spec`，
   再执行
   `python scripts/write_bridge_build_manifest.py dist/vpn_bridge_host.exe --out dist/bridge-build.json`。
   若该清单与 `host/native_host.py` 不一致，安装器会拒绝继续——这正是"源码已改、可执行
   文件仍是旧的"这种情况被发现的地方，而不是等到运行时报出莫名其妙的错误。
2. **运行 `INSTALL-OR-REPAIR.cmd`。** 它会完成上面的五个步骤。
3. **加载扩展**，选择本检出的 `extension` 目录，同方式一。

> **只加载扩展并不能获得 VPN。** 没有注册好的本地宿主时，弹窗可以渲染，但连接控制项
> 无法工作：扩展既无法获取凭据，也无法启动本地代理。请把"只有扩展"视为界面预览。

此后若移动扩展目录，Native Messaging 注册仍然有效，因为它指向固定的每用户运行时位置，
而不是你加载扩展时所用的目录。

### 安装会在机器上留下什么

几乎所有内容都集中在一个每用户目录 `%LOCALAPPDATA%\FirefoxChromeVPNBridge` 下，其中
包含运行时、辅助可执行文件、Python 包、下载的 Playwright 浏览器、日志和凭据。在此
之外，安装会为每个浏览器创建一条每用户 Native Messaging 注册表项：

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
HKCU\Software\Chromium\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
HKCU\Software\BraveSoftware\Brave\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
```

## 获取凭据

下面两条路径取其一即可。浏览器登录是推荐路径，也是唯一不需要 Firefox 的路径。

### 路径 A —— 浏览器登录（推荐，无需 Firefox）

1. 打开扩展弹窗，展开 设置。
2. 点击 **浏览器登录**。弹窗内会出现一个表单。
3. 在表单中填写 Mozilla 账号的**邮箱**和**密码**。这些是 Chromium 原生输入框，输入法
   编辑器（含中文输入法）可正常工作。提交。
4. 本地桥接用一个自带的**无头 Playwright Firefox** 打开 `accounts.firefox.com`，并自行
   通过 Fastly 人机检查。这一过程在后台进行，不会有可见的浏览器窗口。
5. **若出现图片验证码**，图片会显示在弹窗里。输入你看到的字符并提交。答错会自动换一张
   新图。验证码区域出现时会自动滚动到可视位置并聚焦输入框。
6. **Mozilla 通常会要求确认新设备。** 它会把 6 位验证码发到你的邮箱，弹窗会提示你输入。
   若账号启用了基于 TOTP 应用的两步验证，弹窗则提示输入验证器动态码。
7. 成功后弹窗会提示凭据已保存并将自动续期。若该账号此前未使用过 IP 保护，会自动创建
   Guardian 注册。

此后凭据通过纯 HTTP（PyFxA）续期，全程不涉及浏览器。

如果 Mozilla 使会话失效（例如你修改了账号密码），再运行一次浏览器登录即可。

### 路径 B —— 从 Firefox 导入（可选）

在已安装桌面 Firefox 且已登录符合条件的账号的电脑上使用：

1. 先在 Firefox 中启用其内置 IP 保护一次，使配置文件中存有可用的已登录记录。
2. 打开扩展弹窗，展开 设置，点击 **从 Firefox 导入**。
3. 宿主会扫描本机 Firefox 配置文件，并选取最近修改且已验证的记录。

此路径需要桌面 Firefox 保持安装以便导入。由此获得的凭据与其他凭据一样会自动续期；
真正摆脱 Firefox 依赖的是浏览器登录路径。

## 使用 VPN

### 开启与关闭

点击 开启 VPN。扩展会在安装 PAC 脚本之前验证一次真实的 SOCKS5 握手/CONNECT，因此并不
健康的辅助进程不会被显示为已连接。关闭 VPN 会清除本扩展在 Chromium 中的代理设置、停止
SOCKS5 进程并断开 Native Messaging 宿主。宿主只在 VPN 连接活跃期间保持存活，它不是后台
服务。

### 选择出口地区

点击位置按钮选择国家，或保留 推荐（自动）。推荐按实测延迟排序，并排除共享 anycast
出口——这类出口的出口国家由上游决定；这正是"你选的地区就是你得到的地区"的原因。以推荐
项连接时，弹窗会告知实际解析到的地区。

### 按网站分流

在 设置 中选择模式：

- **白名单** —— 只有列表中的网站走 VPN，其余保持直连。
- **黑名单** —— 除列表中的网站外都走 VPN。

在列表输入框中添加域名。域名形态在入库前会校验，因此粘贴的散文会被拒绝，而不会变成
伪造规则。地址栏旁的开关反映当前页面，并向后台查询路由决策，因此开关与 PAC 脚本不会
互相矛盾。用 导出 与 导入 在浏览器或配置文件之间迁移规则；导入是合并，绝不覆盖已有
规则。

### 隐私控制

三项都在 设置 中，说明见[隐私控制](#隐私控制)。WebRTC 防泄漏与 DNS 预解析防护都做了
作用域限定，直连页面不受影响。

### 查询用量

在 本月用量 下点击 查询，可查看套餐、已用流量、剩余流量与重置时间。数据来自 Mozilla
服务端。

### 卸载

- 弹窗中的 **删除本地组件** 会移除本地运行时：私有 Python 包、凭据、日志、本地辅助
  程序以及 Native Messaging 注册表项。扩展保持加载。
- 弹窗中的 **完整卸载** 会执行同样的清理，随后移除扩展本身。
- 删除整个项目文件夹会移除属于本项目的所有本地程序与数据文件。可能残留一个无害的注册表
  指针；它指向已不存在的文件，可以手动删除。

Chromium 没有可在卸载时执行本地程序的钩子，因此直接从 `chrome://extensions` 移除扩展
无法可靠地让辅助程序在事后自我清理。请优先使用弹窗内的 **完整卸载**。

**不要**为了修复问题而删除 `tokens` 目录。凭据就在其中，且会在修复过程中被保留。

## 隐私与安全概要

- 凭据只保存在单独安装的本地运行时中，绝不在本仓库、扩展页面或 `chrome.storage` 中。
- 原始会话令牌不会回传给扩展。
- 日志只记录命令名、结果与非敏感错误文本。
- 桥接会与 Mozilla Firefox Account / Guardian 端点以及上游池所用的 Firefox Remote
  Settings 端点通信。被代理的流量经由所选 Fastly 运营的出口转发。
- 本项目**不**承诺匿名性、完整 VPN 覆盖，也不承诺能抵御恶意的浏览器、操作系统、扩展、
  上游服务或被篡改的构建产物。

完整数据流（含浏览器登录密码的具体处理方式）见 [`PRIVACY.md`](PRIVACY.md)，报告政策见
[`SECURITY.md`](SECURITY.md)。[`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) 记录了每一项
浏览器权限及其用途。

## 故障排查

### 点了按钮没有反应

弹窗、Service Worker 与本地宿主是三个独立进程，因此静默失败有多种可能原因：

1. 查看 `runtime\logs\bridge.log`。每条 Native Messaging 命令及其结果都会记录在此。如果
   你的点击从未出现在日志里，说明请求没有到达宿主。
2. 如果日志里有命令但弹窗仍然没有反应，扩展很可能是旧版本：打开
   `chrome://extensions`，对未打包的 `extension` 目录点击**重新加载**。
3. 如果日志提示扩展版本过旧、不支持浏览器登录，说明加载的扩展构建早于 1.1.0。重新加载。
4. 再打开一次弹窗。若它提示已恢复直连模式，刷新受影响的页面。

### 浏览器登录按钮不可用，或提示缺少组件

本地运行时中没有安装可选的 Playwright 依赖。这只影响浏览器登录；可先用
**从 Firefox 导入** 顶替，或重跑安装脚本补装缺失组件。

### ERR_PROXY_CONNECTION_FAILED

Chromium 到达了配置的本地代理，但本地 SOCKS5 辅助进程已停止，或无法完成上游 CONNECT。
扩展现在会失败开放（fail open），并在弹窗打开时对已死的辅助进程做状态校正。但更新之后：

1. 以同一个 Windows 用户重跑 `INSTALL-OR-REPAIR.cmd`。
2. 在 `chrome://extensions` 中对未打包的 `extension` 目录点击**重新加载**。
3. 打开一次弹窗。若它提示已恢复直连模式，刷新受影响的页面。
4. 只在弹窗报告辅助进程健康后再重新连接。

`127.0.0.1:1090` 上出现 `LISTEN` 即为代理存活的检查依据。不要为了修复此错误而删除
`tokens` 目录。

### 登录流程停止响应

弹窗在 15 分钟后停止轮询，以免卡住的流程无限轮询；宿主则把超过 120 秒未刷新的心跳视为
子进程已死。两种情况都会报告为失败，而不是无限等待。再次点击 **浏览器登录** 即可重试；
在流程运行期间点击它则会取消该流程。

### 凭据失效

如果 Mozilla 使会话失效（常见原因是修改密码），再运行一次 **浏览器登录**。弹窗会显示
一行凭据新鲜度提示，其数据来自经脱敏的续期状态。

### 日志位置

| 日志 | 内容 |
|---|---|
| `runtime\logs\bridge.log` | 每条 Native Messaging 命令、其结果与非敏感错误文本。 |
| `runtime\logs\ipp-pool.log` | 上游池进程的输出。 |
| `runtime\logs\bootstrap-login.log` | 浏览器登录子进程的完整记录。 |

这些文件位于单独安装的本地运行时中，不在本仓库内，且三者都在同一个
`runtime\logs\` 目录下。其中任何一份都不含密码或验证码。当前登录流程不生成任何截图；
清理逻辑里出现的 `bootstrap_after_*.png` 文件名只用于删除旧版本遗留的截图。

## 项目结构

```text
extension/                          Manifest V3 扩展源码（可加载未打包）
host/native_host.py                 Native Messaging 桥接源码
vendor/firefox-ip-protection-pool/  上游衍生的后端兼容源码
scripts/audit_public_tree.py        发布前脱敏审计
scripts/install-or-repair.ps1       为已构建的运行时注册 Native Messaging
config/                             Native Messaging 宿主清单示例
docs/                               使用、构建与权限文档
```

- [`docs/USAGE.md`](docs/USAGE.md) —— 完整使用教程
- [`docs/BUILD.md`](docs/BUILD.md) —— 构建与发布边界
- [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) —— 权限审查
- [`PRIVACY.md`](PRIVACY.md) —— 隐私与数据流
- [`SECURITY.md`](SECURITY.md) —— 安全政策
- [`THIRD_PARTY.md`](THIRD_PARTY.md) —— 第三方声明
- [`CHANGELOG.md`](CHANGELOG.md) —— 版本历史

## 许可与第三方

本项目以 MIT 许可发布；见 [`LICENSE`](LICENSE)。

`vendor/firefox-ip-protection-pool/` 目录包含上游衍生的后端代码，同样采用 MIT 许可。
Python 依赖（`requests`、`PyFxA`，以及可选的 `playwright`）未在此处内置。Firefox、
Mozilla、Firefox IP 保护、Fastly 及相关标识仅用于描述互操作性。完整声明与发布产物规则见
[`THIRD_PARTY.md`](THIRD_PARTY.md)。

## 免责声明

本项目是非官方原型，与 Mozilla、Google、Fastly 或上游项目作者均无隶属、背书或支持关系。
你有责任确认自己的账号具备资格、使用方式符合适用的服务条款，并符合你所在地区的法律。本
原型仍从上游兼容项目的 `main` 分支下载代码；加固后的发行版应固定并审计特定的上游提交或
归档哈希。

## 现状

本项目仍是非官方原型：没有发布签名的发行包，仓库只保存源码，因此在构建并注册本地 host
之前，单独加载 `extension/` 只能看到界面预览（见 [`docs/BUILD.md`](docs/BUILD.md)）。

凭据获取、自动续期与隧道链路已在 64 位 Windows 上针对真实的合格 Mozilla 账号完整跑通，
包括带图片验证码与邮件确认码的浏览器登录。但在依赖它之前，仍建议你在自己的账号、网络与
浏览器上验证一遍。
