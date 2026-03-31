# yusuo

一个纯前端词典与语义搜索项目。

当前功能：
- 关键词搜索
- 语义搜索
- 浏览器内生成 embedding
- 主索引 + 增量 CSV 混合搜索

## 目录结构

```text
.
├── index.html
├── embedding.html
├── assets/
│   ├── app.js
│   ├── embedding.js
│   ├── worker.js
│   └── styles.css
├── data/
│   ├── ci.csv
│   ├── ci.with_embeddings.csv
│   ├── idiom.csv
│   ├── idiom.with_embeddings.csv
│   ├── yusuo.append.csv
│   └── search/
│       ├── yusuo.search.meta.json
│       ├── yusuo.search.embeddings.bin
│       └── yusuo.search.manifest.json
└── scripts/
    └── build_search_index.py
```

## 运行方式

请用本地静态服务器打开，不要直接双击 HTML。

例如：

```bash
python3 -m http.server 8000
```

然后打开：

- 搜索页：`http://localhost:8000/index.html`
- embedding 页：`http://localhost:8000/embedding.html`

## 数据说明

### 原始数据

- `data/ci.csv`
- `data/idiom.csv`

这两份只包含：
- `headword`
- `pinyin_tone`
- `pinyin_plain`
- `definition`

### 带 embedding 的数据

- `data/ci.with_embeddings.csv`
- `data/idiom.with_embeddings.csv`

这是构建搜索索引时使用的完整数据源。

如果仓库里没有这些大文件，可以从这里下载：

- `ci.with_embeddings.csv`
  - https://drive.google.com/file/d/15ljp-u0bkEfkKPgp1j6KbhxuI3G9e3l7/view?usp=drive_link
- `idiom.with_embeddings.csv`
  - https://drive.google.com/file/d/1046LmV1lkp7MtvrpeBIXtFI_PCyPSrbU/view?usp=drive_link

### 搜索索引

搜索页实际读取的是：

- `data/search/yusuo.search.meta.json`
- `data/search/yusuo.search.embeddings.bin`
- `data/search/yusuo.search.manifest.json`

当前向量格式：
- `Float16`
- `512` 维

## 搜索页

`index.html` 支持两种搜索：

### 关键词搜索

会搜索：
- `headword`
- `pinyin_tone`
- `pinyin_plain`
- `definition`

也支持正则。

例如：

- `^阿`
- `^zuo.*si`
- `/^zuo.*si/i`

### 语义搜索

语义搜索使用模型：

- `Xenova/bge-small-zh-v1.5`

搜索页会：
1. 先加载 `meta.json`
2. 在需要语义搜索时再加载 `embeddings.bin`

## Embedding 生成规则

浏览器端 embedding 使用：

- 模型：`Xenova/bge-small-zh-v1.5`
- pooling：`mean`
- normalize：`true`

送入模型的文本规则：

```text
headword；definition
```

不包含拼音。

## Embedding 页面

`embedding.html` 支持：

- 单条生成 embedding
- 解析已有 CSV 行
- 批量导出 CSV
- 分段导出
- 流式写入完整 CSV

批量区有两个预设：

- `Use ci.csv`
- `Use idiom.csv`

## 增量数据

临时新增内容放在：

- `data/yusuo.append.csv`

这个文件的格式和带 embedding 的主库一致：

- `headword`
- `pinyin_tone`
- `pinyin_plain`
- `definition`
- `embedding`

搜索页会额外读取它：

- 关键词搜索会包含这里的词条
- 语义搜索也会使用这里已有的 embedding

所以临时新增内容不需要马上重建主索引也能先搜索。

## 重建搜索索引

运行：

```bash
python3 scripts/build_search_index.py
```

脚本会读取：

- `data/ci.with_embeddings.csv`
- `data/idiom.with_embeddings.csv`
- `data/yusuo.append.csv`
- `data/yusuo.append.*.csv`

然后重建：

- `data/search/yusuo.search.meta.json`
- `data/search/yusuo.search.embeddings.bin`
- `data/search/yusuo.search.manifest.json`

## 当前建议

- 长期维护以 `data/ci.csv`、`data/idiom.csv` 为主
- `.with_embeddings.csv` 更适合作为构建输入
- 搜索页正式使用 `data/search/*`
- 临时新增内容先放 `data/yusuo.append.csv`
