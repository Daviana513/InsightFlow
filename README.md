# InsightFlow

一个连接本地图片与候选 CSV 的多阶段人工审核与数据打标 Agent。

[在线体验 InsightFlow](https://insightflow-research.wuyixuan003.chatgpt.site)

## 产品边界

外部规则脚本、OpenCLIP、视觉模型 API、C2PA 或重复检测程序负责发现候选项；InsightFlow 负责把这些结果变成可恢复、可审计的人工审核任务。

主流程：

1. 选择本地图片文件夹与候选 CSV
2. 检查记录、图片路径、唯一 ID 与缺图
3. 选择审核模板和字段映射
4. 逐图或按重复组进行人工审核
5. 使用数字键快速打标，进度自动保存到本地 SQLite
6. 随时导出保留全部原始列、并追加人工字段的 CSV

InsightFlow 不在主界面中运行模型训练、OpenCLIP 推理或第三方 API；这些外部任务后续可以按需要接入。

## 审核模板

- AI 关键词疑似项：明确 AI 声明、疑似 AI、没有证据、关键词无关、无法判断
- 重复图片候选：完全相同、同图不同尺寸、裁剪或加字、相似但不重复、不相关、无法判断
- 模型判断纠错：保留、排除、待定
- 非信息图残留：信息图、海报、照片、广告、其他、待定
- 来源与 AI 风险：倾向真人、倾向 AI、证据不足、不适用
- 自定义单图打标：是、否、待定

重复图片任务使用并排对比布局，可以指定 `canonical_record_id`。其他模板使用单图布局，同时展示帖文内容和 CSV 上下文字段。

## 本地研究模式

```bash
npm install
npm run agent
```

保持 Local Agent 窗口开启，然后刷新正式站点。选择：

1. 图片文件夹完整路径
2. 待审核 CSV 完整路径

CSV 至少需要稳定 ID 和图片路径字段；重复图任务还需要重复组 ID 字段。图片路径可以是绝对路径，也可以相对于图片文件夹。

本地数据库保存在 CSV 旁的 `.insightflow/insightflow.db`。原图不会上传到公开站点。

导出的 CSV 保留输入文件全部列，并追加：

- `insightflow_task_id`
- `human_review_template`
- `human_decision`
- `human_reason`
- `human_note`
- `canonical_record_id`
- `human_reviewed_at`

## Commands

- `npm run dev`: 启动本地前端
- `npm run agent`: 启动 Local Agent
- `npm run local`: 同时启动前端和 Local Agent
- `npm run build`: 构建验证
- `npm test`: 运行前端与 Local Agent 测试
