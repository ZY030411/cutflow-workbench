# 漫剧切序 · GitHub Pages 前端

此仓库只托管工作台前端。视频上传、Whisper、草稿构建和剪映自动化必须在访问者电脑上运行：

```powershell
cd F:\AI漫剧自动剪辑工作台\workbench
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

启动后本机后端监听 `http://127.0.0.1:8787`。GitHub Pages 页面会自动连接该地址，不经过公网隧道。
