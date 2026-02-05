# tts.exe 使用说明（CLI）

本说明面向 `tts.exe` 独立运行场景，覆盖依赖文件、配置、命令用法、输出格式与排错方式。

## 1. 功能与模式

`tts.exe` 根据 `-i` 输入文件类型自动选择模式：

- **TTS 模式（文本 -> 语音）**：输入 `.txt`，输出 `.wav`
- **对齐模式（音频 -> 时间戳）**：输入音频（`.wav/.mp3/.flac/.m4a/.aac/.pcm`），输出 JSON
- **TTS + 时间戳**：在 TTS 模式下指定 `--timestamps`，自动生成对齐 JSON

说明：

- CLI **不再自动预热语音列表**，需要时请用 `--list-voices` 主动获取。

## 2. 必需文件清单

### 2.1 运行必需（所有模式）

- `tts.exe`
- 配置文件（任选其一）
  - `cli-config.example.json`
  - `configs/config.yaml`

### 2.2 时间戳/对齐必需（使用 `--timestamps` 或对齐模式）

对齐模型目录（默认或通过 `--model-dir` 指定）：

```
speech_timestamp_prediction-v1-16k-offline/
  sherpa-onnx-streaming-zipformer-small-ctc-zh-2025-04-01/
    model.onnx 或 model.int8.onnx 或 ctc-epoch-*.onnx
    tokens.txt
```

### 2.3 Windows 动态库（同目录或 PATH）

以下 DLL 需与 `tts.exe` 同目录或已加入系统 PATH：

- `sherpa-onnx-c-api.dll`
- `onnxruntime.dll`
- `onnxruntime_providers_shared.dll`

建议：把上述 DLL **直接放到 `tts.exe` 同目录**（尤其是将 `tts.exe` 放在 `dist/` 或单独拷贝到其它目录运行时）。部分系统会禁用“当前工作目录”参与 DLL 搜索，导致 DLL 虽在项目根目录但仍无法启动。

## 3. 配置文件说明（JSON）

`cli-config.example.json` 支持字段：

```json
{
  "provider": "microsoft",
  "region": "eastasia",
  "voice": "zh-CN-XiaoxiaoNeural",
  "style": "cheerful",
  "rate": "+0",
  "pitch": "0",
  "align_model_dir": "speech_timestamp_prediction-v1-16k-offline/sherpa-onnx-streaming-zipformer-small-ctc-zh-2025-04-01"
}
```

注意：

- **编码要求**：JSON 文件建议使用 **UTF-8（无 BOM）**。如果出现 `invalid character 'ï' looking for beginning of value`，通常是文件带 BOM 导致解析失败（见 6.4）。
- `api_key`：仅 Microsoft 模式需要（Azure Speech Key）。ZAI 模式默认使用程序内置凭据（也可在 `configs/config.yaml` 的 `zai` 节点覆盖）。

默认值（未填写时）：

- `region`: `eastasia`
- `voice`: `zh-CN-XiaoxiaoNeural`
- `style`: `general`
- `rate`: `0`
- `pitch`: `0`

说明：

- **Microsoft 输出格式固定为 WAV**：`riff-16khz-16bit-mono-pcm`
- **请求超时固定为 120 秒**：`request_timeout = 120`

如需变更格式/超时，需要修改源码并重新编译。

#### provider 说明

- `provider`: `microsoft`（默认）或 `zai`
- 当 `provider="zai"` 时：
  - `voice` 字段表示 ZAI 的 `voice_id`（例如 `system_001` 或克隆音色的 `voice_id`）
  - `region/style/pitch` 会被忽略；`rate` 会尝试映射为 ZAI 的 `speed`

#### 使用 config.yaml（完整配置，可覆盖 ZAI 凭据）

如使用 `configs/config.yaml`（或你自己的 YAML 配置），ZAI 相关字段在 `zai` 节点（留空则使用程序内置默认值）：

```yaml
tts:
  provider: zai
  default_voice: system_001

zai:
  base_url: https://audio.z.ai
  token: ""   # 可选：覆盖内置 token
  user_id: "" # 可选：覆盖内置 user_id
  timeout_sec: 120
```

## 4. 常用命令

### 4.0 查看语音列表（按语言分组 JSON）

```
.\tts.exe --list-voices
```

说明：该命令当前固定走 Microsoft 语音列表接口（不受 `provider` 影响）。如未配置有效的 Microsoft `api_key`，可能调用失败。

输出示例（完整结构）：

```json
{
  "locales": [
    {
      "locale": "zh-CN",
      "voices": [
        {
          "name": "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)",
          "display_name": "Xiaoxiao",
          "local_name": "晓晓",
          "short_name": "zh-CN-XiaoxiaoNeural",
          "gender": "Female",
          "locale": "zh-CN",
          "locale_name": "Chinese (Mainland)",
          "style_list": ["general", "cheerful"],
          "sample_rate_hertz": "24000"
        },
        {
          "name": "Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)",
          "display_name": "Yunxi",
          "local_name": "云希",
          "short_name": "zh-CN-YunxiNeural",
          "gender": "Male",
          "locale": "zh-CN",
          "locale_name": "Chinese (Mainland)",
          "style_list": ["general", "assistant", "calm"],
          "sample_rate_hertz": "24000"
        }
      ]
    },
    {
      "locale": "en-US",
      "voices": [
        {
          "name": "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)",
          "display_name": "Jenny",
          "local_name": "Jenny",
          "short_name": "en-US-JennyNeural",
          "gender": "Female",
          "locale": "en-US",
          "locale_name": "English (United States)",
          "style_list": ["general", "cheerful", "chat"],
          "sample_rate_hertz": "24000"
        }
      ]
    }
  ]
}
```

### 4.1 查看某个音色的风格

```
.\tts.exe --voice-styles zh-CN-XiaoxiaoNeural
```

说明：该命令当前固定走 Microsoft 语音风格查询接口（不受 `provider` 影响）。

输出示例（完整结构）：

```json
{
  "short_name": "zh-CN-XiaoxiaoNeural",
  "display_name": "Xiaoxiao",
  "locale": "zh-CN",
  "gender": "Female",
  "styles": ["general", "cheerful", "assistant", "chat"]
}
```
### 4.2 文本转语音（仅输出 WAV）

```
.\tts.exe -i weban.txt -o output.wav -c cli-config.example.json
```

### 4.2.1 使用 ZAI/GLM TTS（输出 WAV）

把 `cli-config.example.json` 中的 `provider` 改为 `zai`，并把 `voice` 改为 `system_001`（或你的克隆音色 `voice_id`）：

```
.\tts.exe -i weban.txt -o zai_output.wav -c cli-config.example.json
```

#### 4.2.1.1 ZAI 参数映射（与原 CLI 传参保持一致）

- `voice` → `voice_id`
  - 示例：`system_001`
  - 如需使用克隆音色，请在 `audio.z.ai` 获取对应的 `voice_id`，并填入 `voice`
- `rate` → `speed`
  - 解析规则：把 `rate` 当作百分比（允许带 `%`），计算 `speed = 1.0 + rate/100`
  - 例如：`rate="+0"` → `speed=1.0`；`rate="+20"` → `speed=1.2`；`rate="-30"` → `speed=0.7`
  - `speed` 会被限制在 `[0.1, 3.0]`，并四舍五入到 1 位小数
- `style` / `pitch` / `region`：ZAI 模式下会被忽略（保留字段仅为兼容原 CLI 配置结构）

### 4.3 文本转语音 + 时间戳（输出雪诺_bio.json格式）

```
.\tts.exe -i weban.txt -o output.wav --timestamps weban.json -c cli-config.example.json
```

### 4.4 对齐模式（音频 -> 时间戳）

```
.\tts.exe -i input.wav -o align.json --model-dir speech_timestamp_prediction-v1-16k-offline\sherpa-onnx-streaming-zipformer-small-ctc-zh-2025-04-01
```

如需提供参考文本：

```
.\tts.exe -i input.wav -i input.txt -o align.json --model-dir speech_timestamp_prediction-v1-16k-offline\sherpa-onnx-streaming-zipformer-small-ctc-zh-2025-04-01
```

## 5. 输出约束与格式

### 5.1 WAV 输出约束

当启用 `--timestamps` 时：

- **输出文件必须是 `.wav`**，否则会直接报错
- 对齐模型以 **16kHz** 特征配置运行，建议输出为 **16kHz / 16bit / mono PCM**；否则可能出现对齐效果异常或失败

### 5.2 JSON 输出格式（雪诺_bio.json）

所有时间戳 JSON 输出已统一为 **雪诺_bio.json** 格式：

```json
{
  "Metadata": [
    {
      "Type": "WordBoundary",
      "Data": {
        "Offset": 1000000,
        "Duration": 3250000,
        "text": {
          "Text": "明天",
          "Length": 2,
          "BoundaryType": "WordBoundary"
        }
      }
    }
  ]
}
```

字段说明：

- `Offset` / `Duration`：单位为 **100ns ticks**
- `WordBoundary`：英文数字连续字符会合并为一个词，中文按单字分词
- `SentenceBoundary`：按 `。！？!?；;` 或换行分句

## 6. 常见问题排查

### 6.1 语音合成超时

报错：

```
context deadline exceeded (Client.Timeout...)
```

原因：请求超过 **120s** 超时。  
处理：缩短输入文本，或修改源码调整超时后重新编译。

### 6.2 时间戳生成失败

常见原因：

- 模型目录不存在或缺少 `tokens.txt`
- 输出不是 `.wav`
- DLL 缺失导致对齐初始化失败

### 6.3 DLL 相关错误

确保 DLL 与 `tts.exe` 同目录，或加入系统 PATH：

- `sherpa-onnx-c-api.dll`
- `onnxruntime.dll`
- `onnxruntime_providers_shared.dll`

### 6.4 JSON 配置解析失败（BOM/编码问题）

报错：

```
invalid character 'ï' looking for beginning of value
```

原因：`cli-config.example.json`（或你的 JSON 配置）使用了 **UTF-8 with BOM**。  
处理：用编辑器把文件保存为 **UTF-8（无 BOM）** 后重试。

### 6.5 ZAI 合成失败

常见原因：

- 网络不可达 / 被防火墙拦截，导致请求 `audio.z.ai` 失败
- `voice` 不是有效的 `voice_id`
- 内置凭据失效：在 `configs/config.yaml` 的 `zai.token` / `zai.user_id` 中覆盖，或更新程序内置凭据后重新编译

### 6.6 已构建的 tts.exe 无法执行

可能报错：

- `Access is denied.`
- `The specified executable is not a valid application for this OS platform.`

处理建议：

- 确认在 **Windows x64** 上运行，并使用 `GOOS=windows GOARCH=amd64` 构建
- 如果被安全策略拦截，可尝试右键文件属性解除阻止（或执行 `powershell -Command "Unblock-File .\\tts.exe"`）
- 临时验证功能时，可用源码方式跑同等 CLI（仅用于本地排错）：`go run ./cmd/api -i weban.txt -o out.wav -c cli-config.example.json`

## 7. 构建（从源码生成 tts.exe）

```
go fmt ./...
go build -buildvcs=false -ldflags "-s -w" -o tts.exe ./cmd/api
```

如需调整默认输出格式或超时，请修改 `F:/tts-main/cmd/api/main.go` 后重新构建。

## 8. 自动化冒烟测试（ZAI 模式）

项目内置了一键脚本用于验证 **ZAI 合成 + WAV 输出** 是否正常：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "F:/tts-main/script/smoke_zai.ps1"
```

脚本行为：

- `go test ./...`
- 构建 `dist/tts.exe`
- 运行一次 ZAI 集成测试（in-process）
- 按 CLI 参数模式执行一次文本合成，输出 `dist/zai_output.wav` 并校验 WAV 头（`RIFF/WAVE`）
