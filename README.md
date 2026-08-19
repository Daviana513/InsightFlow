# InsightFlow

一个直接读取本地图片与候选 CSV/JSON 的人工审核与数据打标工具。

[在线体验 InsightFlow](https://insightflow-research.wuyixuan003.chatgpt.site)

## 产品边界

外部规则脚本、OpenCLIP、视觉模型 API、C2PA 或重复检测程序负责发现候选项；InsightFlow 负责把这些结果变成可恢复、可审计的人工审核任务。

主流程：

1. 在网页中选择包含图片与候选 CSV/JSON 的本地文件夹
2. 检查记录、图片路径、唯一 ID 与缺图
3. 选择审核模板和字段映射
4. 逐图或按重复组进行人工审核
5. 使用数字键快速打标，进度自动保存在当前浏览器
6. 随时导出完整审核 JSON，也可导出追加人工字段的 CSV

InsightFlow 不在主界面中运行模型训练、OpenCLIP 推理或第三方 API；这些外部任务后续可以按需要接入。

## 审核模板

- AI 关键词疑似项：明确 AI 声明、疑似 AI、没有证据、关键词无关、无法判断
- 重复图片候选：完全相同、同图不同尺寸、裁剪或加字、相似但不重复、不相关、无法判断
- 模型判断纠错：保留、排除、待定
- 非信息图残留：信息图、海报、照片、广告、其他、待定
- 来源与 AI 风险：倾向真人、倾向 AI、证据不足、不适用
- 自定义单图打标：是、否、待定

重复图片任务使用并排对比布局，可以指定 `canonical_record_id`。其他模板使用单图布局，同时展示帖文内容和 CSV 上下文字段。

## 使用本地数据

在网页中点击“打开本地审核文件夹”。候选 CSV 或 JSON 放在文件夹顶层，图片可以放在任意子文件夹：

```text
review-project/
├── candidates.csv
└── images/
    ├── 001.jpg
    └── 002.jpg
```

数据至少需要稳定 ID 和图片路径字段；重复图任务还需要重复组 ID 字段。图片路径既可以是相对路径，也可以只保存文件名。

浏览器只读取用户主动选择的文件。图片不会上传，审核任务保存在浏览器的 IndexedDB 中；刷新页面后任务仍在，但需要重新选择图片文件夹才能再次显示原图。

审核 JSON 包含任务配置、原始字段与人工判断，不包含图片文件，可再次导入继续审核。

导出的 CSV 保留输入文件全部列，并追加：

- `insightflow_task_id`
- `human_review_template`
- `human_decision`
- `human_note`
- `canonical_record_id`
- `human_reviewed_at`

## Commands

- `npm run dev`: 启动本地前端
- `npm run build`: 构建验证
- `npm test`: 运行前端、本地数据解析与旧 Local Agent 测试

`agent/` 中保留了早期的 Local Agent、OpenCLIP 和训练脚本，但正式审核界面不依赖它们。
