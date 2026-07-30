# Windows 发布签名

Windows SmartScreen 可能拦截从浏览器下载的未知发布者程序。更换安装格式、压缩包或
使用自签名证书都不能可靠消除这个提示。LeafMark 的发布流程支持可选 Authenticode
代码签名；未配置证书时仍会发布未签名安装包。

## 所需证书

准备由受信任 CA 签发的 Windows 代码签名证书，并导出为包含私钥的 `.pfx` 文件。
当前工作流直接支持可导出为 PFX 的受信任代码签名证书。普通 SSL 证书和本机生成的
自签名证书不适用；云签名或硬件令牌需要另行接入对应服务的签名命令。

## GitHub Actions Secrets

在仓库的 `Settings → Secrets and variables → Actions` 中配置：

| Secret | 内容 |
| --- | --- |
| `WINDOWS_CERTIFICATE` | `.pfx` 文件的单行 Base64 内容 |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` 导出密码 |
| `WINDOWS_TIMESTAMP_URL` | CA 提供的 RFC 3161 时间戳地址；可选，默认使用 DigiCert |

在 PowerShell 中生成单行 Base64：

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("C:\path\to\leafmark-codesign.pfx")
) | Set-Clipboard
```

不要把证书、私钥、密码或 Base64 内容提交进仓库。

## 发布行为

发布工作流按以下顺序执行：

1. 导入 PFX，并确认其中存在私钥；
2. 由 Tauri 对应用程序和 NSIS 安装包进行 Authenticode 签名；
3. 先创建不可见的草稿 Release；
4. 使用 `Get-AuthenticodeSignature` 验证已配置的签名；
5. 验证后公开 Release。

未配置证书时会跳过签名并发布安装包。配置了证书但签名验证失败时，工作流会失败，
草稿不会公开。
