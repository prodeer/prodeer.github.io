+++
date = '2023-04-27T19:50:05+08:00'
draft = false
mermaid = true
title = 'LSM-tree的数据结构'
categories = ['数据库']
tags = ['LSM-Tree']
+++

学习 LSM-tree（Log-Structured Merge Tree）数据结构的原理、特性以及在数据库中的应用。
<!--more-->


### 一、什么是 LSM-tree

- **名称**：Log-Structured Merge Tree，日志结构合并树。  
- **核心思想**：硬盘的顺序写入速度比随机写入快很多，因此 LSM-tree 以仅追加的形式写入磁盘。  
- **组成**：  
  * **Memtable**：Memory Mutable Table，内存可变表，用于存储最近的写入操作。
  * **SSTable**：Sorted String Table，有序字符串表，是Memtable的持久化版本。
  * **WAL**：Write-Ahead Log，预写日志，用于确保数据的持久性。

### 二、LSM-tree 的数据写入

- **写入策略**：LSM-tree采用“异地更新”策略，即更新数据时不会直接修改原记录，而是将新记录写入新的位置。
- **写入过程**：数据首先写入WAL和Memtable，当Memtable达到一定大小后，会刷新到磁盘成为SSTable。

{{< mermaid bc="#white" >}}
graph TD
    A[开始写操作] --> B[记录到WAL]
    B --> C[写入Memtable]
    C --> D[是更新操作吗?]
    D -- 是 --> E[在Memtable中更新数据]
    D -- 否 --> F[在Memtable中插入新数据]
    E --> G[Memtable达到阈值?]
    F --> G
    G -- 是 --> H[Memtable转为Immutable Memtable]
    G -- 否 --> I[继续写操作]
    H --> J[Minor Compaction]
    J --> K[Immutable Memtable写入磁盘成为Level 0 SSTable]
    K --> L[结束写操作]
{{< /mermaid >}}

以下是LSM-tree写数据的更新流程：

#### 写操作流程

1. **记录日志（WAL）**：  
   所有写操作（包括插入、更新和删除）首先记录到预写日志（Write-Ahead Log, WAL）中。WAL确保数据的持久性和一致性，即使在系统崩溃的情况下，也可以通过WAL恢复数据.

2. **写入Memtable**：  
   数据从WAL写入到内存中的Memtable。Memtable通常使用有序数据结构（如跳表或红黑树）来存储数据，以便快速访问和保持数据有序.

   如果是更新操作，LSM-tree会在Memtable中为该键值对创建一个新的版本，而不是直接修改旧的记录。

3. **Memtable转为Immutable Memtable**：  
   当Memtable达到一定大小后，它会被冻结成Immutable Memtable。此时，新的写入操作会进入一个新的Memtable。

4. **Minor Compaction**：  
   Immutable Memtable会被写入磁盘，形成SSTable的Level 0层。这个过程称为Minor Compaction。

#### 更新操作的具体步骤

* **更新在内存中的数据**：  
  如果待更新的数据已经在Memtable中，直接在Memtable中更新该数据，创建一个新的版本。
* **更新在磁盘中的数据**：  
  如果待更新的数据不在Memtable中，LSM-tree会将新的更新记录写入到Memtable中，而不是直接修改磁盘上的旧记录。

#### 合并操作

LSM-tree的合并操作发生在写操作过程中：  
- **Minor Compaction**：当Memtable达到一定大小后，会被冻结成Immutable Memtable，并触发Minor Compaction。Minor Compaction将Immutable Memtable的数据写入磁盘，形成Level 0的SSTable。
- **Major Compaction**：随着Level 0层的SSTable数量增多，会触发Major Compaction。Major Compaction将多个SSTable合并成更少、更大的SSTable，并移动到更高的层级。合并过程中会删除过时的数据，并将新的数据版本合并到更低层次的SSTable中。

- **目的**：  
  - **优化存储空间**：通过合并操作，可以删除重复的键和标记为删除的数据，从而减少存储空间的浪费。
  - **提高查询性能**：减少SSTable的数量和层级，可以降低读取数据时需要访问的文件数量，从而减少读放大，提高查询性能。

### 三、LSM-tree 的数据读取

* **读取顺序**：先从Memtable查找，然后是Immemtable和SSTable，从Level 0到Level N逐层查找，以确保找到最新的数据。
* **优化**：使用布隆过滤器减少不必要的磁盘I/O操作。

{{< mermaid bc="#white" >}}
graph TD
    A[开始读操作] --> B[查询Memtable]
    B -- 未找到 --> C[查询Immutable Memtable]
    C -- 未找到 --> D[查询SSTable层级]
    D -- 未找到 --> E[查询下一层级SSTable]
    E -- 未找到 --> F[结束读操作]
    B -- 找到 --> G[返回结果]
    C -- 找到 --> G
    D -- 找到 --> G
    E -- 找到 --> G
{{< /mermaid >}}

以下是LSM-tree读数据的流程：

1. **查询Memtable**：  
   首先在内存中的Memtable中查找目标键值对。Memtable是最近写入数据的存储位置，因此最先被查询。

2. **查询Immutable Memtable**：  
   如果在Memtable中未找到数据，接着查询Immutable Memtable。Immutable Memtable是已经写入磁盘但尚未合并的Memtable。

3. **查询SSTable层级**：  
   从最高层级的SSTable（如L0层）开始查询。如果在当前层级未找到数据，继续查询下一层级的SSTable，直到找到数据或查询完所有层级。

   在每个SSTable中，数据是有序排列的，可以使用二分查找等高效算法进行快速查找。

4. **使用Bloom Filter优化**：  
   在查询SSTable之前，可以使用Bloom Filter来判断该SSTable是否可能包含目标键。如果Bloom Filter判断不存在，则跳过该SSTable的查询，从而减少不必要的磁盘I/O操作。

### 四、为什么用 LSM-tree&#x20;

以下是LSM-tree与B-tree在多个方面的区别对比：

| 特性         | LSM-tree                                                   | B-tree                                                   |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| **数据结构**   | 由Memtable、SSTable和WAL组成，数据先写入内存再批量写入磁盘                     | 树形结构，数据存储在树的节点中，节点按顺序排列                                  |
| **写入性能**   | 高，顺序写入，写入操作首先写入内存中的Memtable和WAL，然后批量刷新到磁盘                  | 较低，随机写入，每次写入可能需要更新树结构，导致磁盘页的频繁读写和分裂操作                    |
| **读取性能**   | 较低，读取操作需要从多个层级的SSTable和Memtable中查找数据，可能需要进行多次磁盘I/O操作，导致读放大 | 高，树结构的高度较低且数据按顺序存储，查询操作可以通过树的结构快速定位到目标数据，通常只需要少量的磁盘I/O操作 |
| **适用场景**   | 写入密集型的应用场景，如日志系统、实时分析等，需要处理大量写入操作且对写入性能要求较高的场景             | 读取密集型的应用场景，如关系型数据库中的索引，需要频繁进行查询和范围搜索的场景                  |
| **写放大**    | 较小，因为写入操作不需要在写入时进行复杂的树结构调整                                 | 较大，因为每次写入操作可能需要更新树结构，导致频繁的随机磁盘I/O操作                      |
| **读放大**    | 较大，由于数据可能分布在多个层级中，读取操作需要访问更多的数据层级                          | 较小，因为数据按顺序存储且树的高度较低，查询操作较为直接                             |
| **空间放大**   | 较大，因为需要存储多个版本的数据和删除标记等                                     | 较小，因为数据存储紧凑，没有额外的版本信息和删除标记等                              |
| **一致性**    | 通过WAL确保数据的持久性和一致性                                          | 通过树结构的自平衡和页分裂等机制保证数据的一致性                                 |
| **应用场景举例** | RocksDB、LevelDB、Cassandra、HBase等                           | MySQL InnoDB、SQL Server、MongoDB WiredTiger等              |

在选择数据结构时，需要根据具体的应用场景和性能需求来决定。  
* 如果写入操作是主要瓶颈，LSM-tree可能是更好的选择；
* 如果读取性能是关键，B-tree可能更适合。
