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

## 3. 配置文件说明（JSON）

`cli-config.example.json` 支持字段：

```json
{
  "region": "eastasia",
  "voice": "zh-CN-XiaoxiaoNeural",
  "style": "cheerful",
  "rate": "+0",
  "pitch": "0",
  "align_model_dir": "speech_timestamp_prediction-v1-16k-offline/sherpa-onnx-streaming-zipformer-small-ctc-zh-2025-04-01"
}
```

默认值（未填写时）：

- `region`: `eastasia`
- `voice`: `zh-CN-XiaoxiaoNeural`
- `style`: `general`
- `rate`: `0`
- `pitch`: `0`

说明：

- **输出格式写死为 WAV**：`riff-16khz-16bit-mono-pcm`
- **请求超时写死为 120 秒**：`request_timeout = 120`

如需变更格式/超时，需要修改源码并重新编译。

## 4. 常用命令

### 4.0 查看语音列表（按语言分组 JSON）

```
.\tts.exe --list-voices
```

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
- 输出格式固定为 **16kHz / 16bit / mono PCM**

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

## 7. 构建（从源码生成 tts.exe）

```
gofmt -w "F:/tts-main/internal/align/bio.go" "F:/tts-main/cmd/api/main.go"
go build -ldflags "-s -w" -o tts.exe ./cmd/api
```

如需调整默认输出格式或超时，请修改 `F:/tts-main/cmd/api/main.go` 后重新构建。
