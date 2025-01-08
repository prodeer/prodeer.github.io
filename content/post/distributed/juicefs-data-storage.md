+++
date = '2025-01-08T18:58:22+08:00'
draft = false
mermaid = true
title = '掌握 JuiceFS：数据存储的基本单元'
categories = ['分布式']
tags = ['分布式文件系统', 'JuiceFS']
+++

传统文件系统只能使用本地磁盘存储数据和对应的元数据，JuiceFS 会将数据格式化以后存储在对象存储，同时会将文件的元数据存储在元数据引擎，具有很好的扩展性，可以轻松处理大量数据和高并发访问。本文学习JuiceFS 文件系统的架构和它的Chunk、Slice 和 Block。

<!--more-->

### 一、JuiceFS 的技术架构
JuiceFS 文件系统由三个部分组成：JuiceFS 客户端（Client）、数据存储（Data Storage）、元数据引擎（Metadata Engine）。  
- **JuiceFS 客户端（Client）**：所有文件读写，以及碎片合并、回收站文件过期删除等后台任务，均在客户端中发生。客户端需要同时与对象存储和元数据引擎打交道。客户端支持多种接入方式。
- **数据存储（Data Storage）**：文件将会被切分上传至对象存储服务。JuiceFS 支持几乎所有的公有云对象存储，同时也支持 OpenStack Swift、Ceph、MinIO 等私有化的对象存储。
- **元数据引擎（Metadata Engine）**：用于存储文件元数据（metadata）。

{{< mermaid bc="#white" >}}
graph TD
    subgraph JuiceFS 客户端 [JuiceFS 客户端]
        G1[客户端]
        G1 -->|文件读写| H1[对象存储]
        G1 -->|元数据操作| I1[元数据引擎]
    end

    subgraph 接入方式 [接入方式]
        A1[FUSE]
        A2[Hadoop Java SDK]
        A3[Kubernetes CSI 驱动]
        A4[S3 网关]
        A5[WebDAV 服务]
    end

    A1 -->|挂载到服务器| B1[POSIX 兼容]
    A2 -->|替代 HDFS| C1[Hadoop]
    A3 -->|提供海量存储| D1[Kubernetes]
    A4 -->|直接接入| E1[S3 兼容应用]
    A5 -->|HTTP 协议| F1[WebDAV 客户端]

    subgraph 数据存储 [数据存储]
        H1 --> J1[公有云对象存储]
        H1 --> J2[私有化对象存储]
    end

    subgraph 元数据引擎 [元数据引擎]
        I1 --> N1[Redis]
        I1 --> O1[TiKV]
        I1 --> P1[MySQL/MariaDB]
        I1 --> Q1[PostgreSQL]
        I1 --> R1[SQLite]
    end

    B1 --> G1
    C1 --> G1
    D1 --> G1
    E1 --> G1
    F1 --> G1
{{< /mermaid >}}

### 二、JuiceFS 数据存储的基本单元
在 JuiceFS 中，Chunk、Slice 和 Block 是文件存储和处理的三个核心概念，它们共同构成了 JuiceFS 的数据管理机制。

{{< mermaid bc="#white" >}}
graph TD
    A[文件] --> B[Chunk]
    B -->|一个文件由一个或多个组成| C[Chunk]
    C --> D[Slice]
    D -->|一个或多个 Slice 组成一个 Chunk| E[Slice]
    E --> F[Block]
    F -->|一个 Slice 可以拆分成多个 Block| G[Block]

    subgraph 说明
        H[每个 Chunk 最大 64MB]
        I[每个 Slice 不超过 64MB]
        J[每个 Block 默认最大 4MB]
    end

    C --> H
    E --> I
    G --> J
{{< /mermaid >}}

如上图所示：  
1. **Chunk**：  
- 一个 Chunk 是 JuiceFS 中文件存储的基本单位，每个 Chunk 的大小固定，最大为 64MB。
- 文件被分割成一个个 Chunk，每个 Chunk 包含文件的一部分数据。
- Chunk 的设计允许 JuiceFS 优化大文件的存储和访问性能，因为可以独立地处理和访问每个 Chunk。
2. **Slice**：
- Slice 是文件写入操作的逻辑单元，它表示文件中的一段连续数据。
- 一个 Slice 属于一个 Chunk，并且不能跨越 Chunk 边界，因此 Slice 的长度不会超过 64MB。
- 当文件被写入时，数据首先被写入到 Slice 中。Slice 可以看作是文件在内存中的缓冲区，当需要持久化数据时，Slice 中的数据会被写入到 Block 中。
3. **Block**：
- Block 是 JuiceFS 中数据的物理存储单元，它是对象存储中实际存储数据的最小单位。
- 为了提高写入性能，Slice 在持久化到对象存储时会被进一步拆分成多个 Block，每个 Block 默认最大为 4MB。
- Block 可以并发写入对象存储，这有助于提高大文件写入的性能。
- 在对象存储中，Block 以数字编号的文件形式存在，这些文件与 Chunk 和 Slice 的对应关系由元数据引擎管理。

这三者的协同工作方式如下：
- 当用户写入文件时，数据首先被写入到 Slice 中。
- 如果文件写入操作是连续的，那么每个 Chunk 可能只包含一个 Slice。
- 当调用 flush 操作或者 JuiceFS 客户端自动触发时，Slice 中的数据会被持久化到对象存储中。
- 在持久化过程中，Slice 被拆分成多个 Block，这些 Block 被并发写入对象存储以提高性能。
- 元数据引擎记录了文件的元数据以及 Chunk、Slice 和 Block 之间的映射关系，这对于文件的读取和数据恢复至关重要。
这种设计使得 JuiceFS 能够高效地处理大规模数据，同时保持高性能的读写操作。

### 三、JuiceFS 中 Chunk、Slice 和 Block 的应用场景
#### 场景一：大文件的顺序写入
假设有一个大文件需要被写入 JuiceFS：
1. **Chunk**：文件被分割成多个 64MB 的 Chunk。如果文件大小为 160MB，那么它将被分割成 3 个 Chunk。
2. **Slice**：文件的写入操作是顺序的，每个 Chunk 将包含一个 Slice。第一个 Chunk 的 Slice 将包含前 64MB 的数据，第二个包含接下来的 64MB，第三个包含剩余的 32MB。
3. **Block**：当用户执行 flush 操作或 JuiceFS 客户端自动触发 flush 时，这些 Slice 将被拆分成 Block 并写入对象存储。每个 Slice 被拆分成多个 Block，例如，第一个和第二个 Chunk 的 Slice 将各被拆分成 16 个 Block（每个 4MB），第三个 Slice 将被拆分成 8 个 Block。

{{< mermaid bc="#white" >}}
graph TB
    subgraph File["File 160MB"]
        subgraph Chunk1["Chunk 1 64MB"]
            slice1_1["Slice 1"]
        end
        subgraph Chunk2["Chunk 2 64MB"]
            slice2_1["Slice 2"]
        end
        subgraph Chunk3["Chunk 3 <64MB"]
            slice3_1["Slice 3"]
        end
    end

    subgraph Block["Block"]
        direction LR
        block1_1["Block 1 (4MB)"]
        block1_2["Block 2 (4MB)"]
        %% ... (其他 Block 节点)
        block1_16["Block 16 (4MB)"]
        block2_1["Block 1 (4MB)"]
        block2_2["Block 2 (4MB)"]
        %% ... (其他 Block 节点)
        block2_16["Block 16 (4MB)"]
        block3_1["Block 1 (4MB)"]
        block3_2["Block 2 (4MB)"]
        %% ... (其他 Block 节点)
        block3_8["Block 8 (4MB)"]
    end

    slice1_1 -->|"Split into"| block1_1
    slice1_1 --> block1_2
    %% ... (其他 Block 连接)
    slice1_1 --> block1_16

    slice2_1 -->|"Split into"| block2_1
    slice2_1 --> block2_2
    %% ... (其他 Block 连接)
    slice2_1 --> block2_16

    slice3_1 -->|"Split into"| block3_1
    slice3_1 --> block3_2
    %% ... (其他 Block 连接)
    slice3_1 --> block3_8
{{< /mermaid >}}

#### 场景二：小文件的随机写入
假设多个小文件被随机写入 JuiceFS：
1. **Chunk**：每个文件根据其大小被分配到一个或多个 Chunk 中。小文件可能共享同一个 Chunk。
2. **Slice**：每个文件的写入操作创建一个新的 Slice。如果文件很小，可能不足以填满一个 Block，但仍然会创建一个新的 Slice。
3. **Block**：当这些小文件被 flush 时，它们的 Slice 被拆分成 Block。如果一个文件只有 1MB，它可能被拆分成 3 个 Block，每个 Block 大小为 4MB，最后一个 Block 只有 1MB 的有效数据。

{{< mermaid bc="#white" >}}
graph TB
    subgraph "File"
        direction TB

        subgraph "Chunk 1"
            slice1_1["Slice 1 (Small File 1MB)"]
            slice1_2["Slice 2 (Small File 2MB)"]
        end
        subgraph "Chunk 2"
            slice2_1["Slice 1 (Small File 3MB)"]
        end

        subgraph "Block"
            direction LR
            block1_1["Block 1 (4MB)"]
            block1_2["Block 2 (4MB)"]
            block1_3["Block 3 (1MB)"]
            block2_1["Block 1 (4MB)"]
            block2_2["Block 2 (1MB)"]
            block2_3["Block 3 (4MB)"]
        end

        slice1_1 -->|"Split into"| block1_1
        slice1_1 --> block1_2
        slice1_1 --> block1_3

        slice1_2 -->|"Split into"| block2_1
        slice1_2 --> block2_2

        slice2_1 -->|"Split into"| block2_3
    end

{{< /mermaid >}}

#### 场景三：文件的追加写入
当文件被追加写入时：
1. **Chunk**：如果追加的数据量不足以填满当前 Chunk，它将被添加到现有的 Chunk 中。
2. **Slice**：追加写入将创建新的 Slice。如果追加的数据量很小，可能会创建多个 Slice，每个 Slice 包含少量数据。
3. **Block**：当这些追加的 Slice 被 flush 时，它们将被拆分成 Block。如果追加的数据量很小，可能会产生许多小于 4MB 的 Block。

{{< mermaid bc="#white" >}}
graph TB
    subgraph "File"
        direction TB

        subgraph "Chunk 1"
            slice1_1["Slice 1"]
            slice1_2["Slice 2"]
            slice1_3["Slice 3"]
        end

        subgraph "Block"
            direction LR
            block1_1["Block 1 (4MB)"]
            block1_2["Block 2 (2MB)"]
            block1_3["Block 3 (1MB)"]
            block1_4["Block 4 (3MB)"]
        end

        slice1_1 -->|"Flushed into"| block1_1
        slice1_2 -->|"Flushed into"| block1_2
        slice1_3 -->|"Flushed into"| block1_3
        slice1_3 -->|"Flushed into"| block1_4
    end

{{< /mermaid >}}

#### 场景四：文件的覆盖写入
当文件的特定部分被覆盖写入时：
1. **Chunk**：覆盖写入可能发生在文件的任何 Chunk 中。
2. **Slice**：新的数据将创建一个新的 Slice，这个 Slice 可能与现有的 Slice 重叠。
3. **Block**：当这个新的 Slice 被 flush 时，它将被拆分成 Block。如果覆盖写入导致数据量减少，可能会减少 Block 的数量；如果增加，则可能增加 Block 的数量。

{{< mermaid bc="#white" >}}
graph TB
    subgraph "File"
        direction TB

        subgraph "Chunk 1"
            slice1_1["Slice 1 (Original Data)"]
            slice1_2["Slice 2 (Overwrite Data)"]
        end

        subgraph "Block"
            direction LR
            block1_1["Block 1 (4MB)"]
            block1_2["Block 2 (4MB)"]
            block1_3["Block 3 (2MB)"]
        end

        slice1_1 -->|"Flushed into"| block1_1
        slice1_1 --> block1_2
        slice1_2 -->|"Flushed into"| block1_3
    end

{{< /mermaid >}}

### 小结
JuiceFS 的元数据引擎会更新文件的元数据，包括 Chunk、Slice 和 Block 的映射关系，以及文件的最新状态。这样，无论文件如何被写入，JuiceFS 都能确保数据的一致性和可访问性。