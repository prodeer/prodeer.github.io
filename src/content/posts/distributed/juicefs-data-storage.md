---
title: "掌握 JuiceFS：数据存储的基本单元"
date: 2025-01-08
category: distributed
tags: ["分布式文件系统", "JuiceFS"]
description: "传统文件系统只能使用本地磁盘存储数据和对应的元数据，JuiceFS 会将数据格式化以后存储在对象存储，同时会将文件的元数据存储在元数据引擎，具有很好的扩展性，可以轻松处理大量数据和高并发访问。本文学习..."
---



传统文件系统只能使用本地磁盘存储数据和对应的元数据，JuiceFS 会将数据格式化以后存储在对象存储，同时会将文件的元数据存储在元数据引擎，具有很好的扩展性，可以轻松处理大量数据和高并发访问。本文学习JuiceFS 文件系统的架构和它的Chunk、Slice 和 Block。

<!--more-->

## 一、JuiceFS 的技术架构
JuiceFS 文件系统由三个部分组成：JuiceFS 客户端（Client）、数据存储（Data Storage）、元数据引擎（Metadata Engine）。  
- **JuiceFS 客户端（Client）**：所有文件读写，以及碎片合并、回收站文件过期删除等后台任务，均在客户端中发生。客户端需要同时与对象存储和元数据引擎打交道。客户端支持多种接入方式。
- **数据存储（Data Storage）**：文件将会被切分上传至对象存储服务。JuiceFS 支持几乎所有的公有云对象存储，同时也支持 OpenStack Swift、Ceph、MinIO 等私有化的对象存储。
- **元数据引擎（Metadata Engine）**：用于存储文件元数据（metadata）。



![Mermaid 图表](/images/mermaid/mermaid-9e6e969a-2.svg)



### 场景二：小文件的随机写入
假设多个小文件被随机写入 JuiceFS：
1. **Chunk**：每个文件根据其大小被分配到一个或多个 Chunk 中。小文件可能共享同一个 Chunk。
2. **Slice**：每个文件的写入操作创建一个新的 Slice。如果文件很小，可能不足以填满一个 Block，但仍然会创建一个新的 Slice。
3. **Block**：当这些小文件被 flush 时，它们的 Slice 被拆分成 Block。如果一个文件只有 1MB，它可能被拆分成 3 个 Block，每个 Block 大小为 4MB，最后一个 Block 只有 1MB 的有效数据。



![Mermaid 图表](/images/mermaid/mermaid-72d994f8-3.svg)


### 场景三：文件的追加写入
当文件被追加写入时：
1. **Chunk**：如果追加的数据量不足以填满当前 Chunk，它将被添加到现有的 Chunk 中。
2. **Slice**：追加写入将创建新的 Slice。如果追加的数据量很小，可能会创建多个 Slice，每个 Slice 包含少量数据。
3. **Block**：当这些追加的 Slice 被 flush 时，它们将被拆分成 Block。如果追加的数据量很小，可能会产生许多小于 4MB 的 Block。



![Mermaid 图表](/images/mermaid/mermaid-14e7cc15-4.svg)


### 场景四：文件的覆盖写入
当文件的特定部分被覆盖写入时：
1. **Chunk**：覆盖写入可能发生在文件的任何 Chunk 中。
2. **Slice**：新的数据将创建一个新的 Slice，这个 Slice 可能与现有的 Slice 重叠。
3. **Block**：当这个新的 Slice 被 flush 时，它将被拆分成 Block。如果覆盖写入导致数据量减少，可能会减少 Block 的数量；如果增加，则可能增加 Block 的数量。



![Mermaid 图表](/images/mermaid/mermaid-0ecf1d8c-5.svg)



## 小结
JuiceFS 的元数据引擎会更新文件的元数据，包括 Chunk、Slice 和 Block 的映射关系，以及文件的最新状态。这样，无论文件如何被写入，JuiceFS 都能确保数据的一致性和可访问性。