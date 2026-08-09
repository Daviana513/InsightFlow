# InsightFlow

一个可复现、可审计的人机协同图像数据筛选工作台。这个仓库首先提供一个可公开体验的脱敏演示版，用于展示研究工作流、人工决策与单图证据链；后续可在同一界面接入真实模型和私有数据。

[在线体验 InsightFlow](https://insightflow-research.wuyixuan003.chatgpt.site)

![InsightFlow — Reproducible Data Screening](public/insightflow-social.png)

## 解决什么问题

传统研究脚本很难让合作者复查“某张图片为什么被保留或剔除”。InsightFlow 把筛选流程、模型输出、人工纠正和来源风险检查集中在一个产品界面中，让每个最终决策都有迹可循，也让相同配置可以被再次运行。

## 固化的筛选流程

1. 前期预处理（规则与范围筛选）
2. OpenCLIP 高召回筛选（`p >= 0.10` 才进入下一阶段）
3. GPT-5.5 单图审核
4. 人工复核并纠正 GPT 判断
5. 人工清除 GPT 残留的 poster / photograph 等非信息图
6. C2PA 来源凭证检查
7. 腾讯云 AI 图片检测，辅助人工复核
8. 形成最终 dataset

其中 OpenCLIP 阈值只用于高召回候选筛选；C2PA 与腾讯云检测只提供来源和风险线索，不自动决定图片是否属于信息图，也不自动删除数据。

## 当前公开演示版

- 三个相互独立的人工队列：GPT 纠正、残留清理、AI 图片复核
- 支持按钮和键盘快捷键 `1 / 2 / 3` 作出保留、剔除、暂不确定的决定
- 展示每张图片从预处理到最终人工结论的完整证据链
- 导出审核结果 CSV
- 导出包含阈值、模型版本、规则与阶段顺序的复现清单 JSON
- 使用合成、脱敏案例，不包含论文私有数据或第三方图片

浏览器刷新后演示状态会重置。这是有意设计的公开作品集边界，而不是论文正式运行环境。

## 研究模式的下一阶段

正式研究模式将增加一个轻量后端，用于批量上传、任务队列、持久化人工判断、断点续跑和权限控制；模型密钥只保存在服务器端。前端界面和决策字段保持不变，以便公开演示与论文工作流共用同一套产品逻辑。

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build and verify the server-rendered product shell
- `npm run db:generate`: generate Drizzle migrations after schema changes
