+++
date = '2024-12-16T23:30:00+08:00'
title = 'Golang的map扩容和源码分析'
draft = false
categories = ['Golang']
tags = ['Golang', '源代码']
+++

Go 中的 map 是一种内置的数据结构，它实现了哈希表的特性，可以存储键值对。本篇文章学习map的底层结构和扩容机制。  
map 的相关部分可以在源码下的 `runtime/map.go` 文件中查看，以下源代码基于 go1.23.3 版本，有删减。

<!--more-->
### 一、map 的底层结构

Go 中的 `map` 在内存中主要涉及的结构有`hmap`和`bmap`。  
每个 map 的底层结构是`hmap`，是有若干个结构为`bmap`的bucket组成的数组。每个bucket底层都采用链表结构。

#### 1.1 hmap 结构体

它是 `map` 的核心结构体，包含了 map 的元数据和指向底层数据的指针。`hmap` 结构体中包含的字段有：

```go
type hmap struct {
    count     int    // 表示 map 中存储的键值对数量。
    flags     uint8  // 用于存储 map 的一些标志位，如是否只读等。
    B         uint8  // 表示哈希表的桶数组的大小，具体来说，桶数组的大小为 2^B。
    noverflow uint16 // 表示 map 中溢出桶的大致数量。
    hash0     uint32 // 哈希种子，用于计算哈希值时的初始值，以避免哈希碰撞。

    buckets    unsafe.Pointer // 指向桶数组的指针，桶数组是存储键值对的直接容器。
    oldbuckets unsafe.Pointer // 在扩容时使用，指向旧的桶数组。
    nevacuate  uintptr        // 在扩容时使用，记录需要重新分配的桶的数量。

    extra *mapextra // 额外记录overflow桶信息，不一定每个map都有
}

// 额外记录overflow桶信息
type mapextra struct {
    overflow    *[]*bmap
    oldoverflow *[]*bmap

    nextOverflow *bmap    // 指向下一个可用overflow桶
}
```

#### 1.2 bmap结构体

`bmap` 是 map 的底层数据结构之一，通常被称为桶（bucket）。每个 `bmap` 结构体可以存储最多 8 个键值对。以下是 `bmap` 结构体的主要组成部分：

```go
type bmap struct {
    tophash [abi.MapBucketCount]uint8
}

// 底层定义的常量 abi/map.go 
const (
    MapBucketCountBits = 3 
    MapBucketCount     = 1 << MapBucketCountBits

    MapMaxKeyBytes  = 128
    MapMaxElemBytes = 128 
)
```

实际上编译期间会动态生成一个新的结构体：（很多资料都这么说，但没找到源代码，待研究）

* **tophash**：一个长度为 `abi.MapBucketCount` 的 uint8 数组，每个元素包含每个键的哈希值的高 8 位。这个数组用于快速查找和比较键值对，以提高搜索效率。
* **keys和elems**：一个长度为 8 的数组，存储键值对的键和值。
* **overflow**：一个指针，当桶中的元素数量超过其容量时，会使用这个溢出指针指向下一个 `bmap`，形成一个链表结构。

见下图，hmap和bmap的结构是这样的 ：
![map底层结构](/map-substructure.png "map底层结构")

### 二、map 的扩容机制

map 扩容的函数是 `hashGrow` ，当 `map` 中的元素数量增加到一定程度，超过了负载因子（load factor），或者存在太多的溢出桶（overflow buckets）时，就会触发扩容操作。下面是对这段代码的逐行分析：

#### 2.1 函数签名

```go
func hashGrow(t *maptype, h *hmap)
```
该函数接受两个参数：

* `t` 是指向 `maptype` 的指针，它包含了 `map` 的类型信息；
* `h` 是指向 `hmap` 的指针，它包含了 `map` 的实际数据和元数据。

#### 2.2 扩容判断

```go
bigger := uint8(1)
if !overLoadFactor(h.count+1, h.B) {
        bigger = 0
        h.flags |= sameSizeGrow
}
```

初始化 `bigger` 为 1，意味着默认情况下桶的数量会翻倍。 &#x20;

通过调用 `overLoadFactor` 函数检查是否需要扩容。如果不需要（即元素数量没有超过负载因子），则将 `bigger` 设置为 0，表示桶的数量不变，同时设置 `sameSizeGrow` 标志，表示进行的是横向扩展（即桶的数量不变，但需要重新分配空间以减少溢出桶的数量）。

#### 2.3 旧桶数组

```go
oldbuckets := h.buckets
```

保存当前的桶数组，以便在扩容过程中使用。

#### 2.4 新桶数组

```go
newbuckets, nextOverflow := makeBucketArray(t, h.B+bigger, nil)
```

调用 `makeBucketArray` 函数创建一个新的桶数组。新桶数组的大小为 `2^(h.B+bigger)`，即根据 `bigger` 的值决定是翻倍还是保持不变。

#### 2.5 更新标志和元数据

```go
flags := h.flags &^ (iterator | oldIterator)
if h.flags&iterator != 0 {
        flags |= oldIterator
}
// commit the grow (atomic wrt gc)
h.B += bigger
h.flags = flags
h.oldbuckets = oldbuckets
h.buckets = newbuckets
h.nevacuate = 0
h.noverflow = 0
```

更新 `hmap` 的标志，清除 `iterator` 和 `oldIterator` 标志，如果存在迭代器，则设置 `oldIterator` 标志。

更新 `hmap` 的元数据，包括桶的数量 `B`，桶数组 `buckets`，旧桶数组 `oldbuckets`，以及重置疏散计数器 `nevacuate` 和溢出桶计数器 `noverflow`。

#### 2.6 处理溢出桶

```go
if h.extra != nil && h.extra.overflow != nil {
        // Promote current overflow buckets to the old generation.
        if h.extra.oldoverflow != nil {
                throw("oldoverflow is not nil")
        }
        h.extra.oldoverflow = h.extra.overflow
        h.extra.overflow = nil
}
if nextOverflow != nil {
        if h.extra == nil {
                h.extra = new(mapextra)
        }
        h.extra.nextOverflow = nextOverflow
}
```

如果存在额外的溢出桶，将当前的溢出桶提升到旧的一代（即 `oldoverflow`），以便在后续的疏散过程中处理。

如果在创建新桶数组时产生了新的溢出桶，将其保存在`h.extra.nextOverflow` 中。

#### 2.7 增量疏散

```go
// the actual copying of the hash table data is done incrementally
// by growWork() and evacuate().
```

最后两行是注释，说明了实际的数据复制（即从旧桶数组到新桶数组的键值对迁移）是通过 `growWork` 和 `evacuate` 函数增量完成的。这是为了避免在扩容过程中对 `map` 的性能产生太大影响。

#### 2.8 扩容小结

当 map 中的键值对数量达到一定阈值时，Go 会进行扩容操作，以避免哈希表过于拥挤，导致性能下降。扩容的具体机制如下：

* **扩容条件**：当 `map` 中的键值对数量超过当前桶数组大小的一定比例（例如 6.5 倍）时，会触发扩容。
* **扩容过程**：
  1. 创建一个新的桶数组，其大小为当前桶数组大小的两倍。
  2. 将旧桶数组中的所有键值对重新分配到新桶数组中。
  3. 更新 `map` 的相关元数据，如 `B` 字段和 `buckets` 指针。
* **扩容策略**：扩容操作是一个比较耗时的过程，因为它需要重新计算所有键的哈希值，并将键值对重新分配到新的桶中。为了减少扩容对性能的影响，Go 采用了逐步扩容的策略，即在扩容过程中，会逐步将旧桶数组中的键值对迁移到新桶数组中，而不是一次性完成。





参考资料:
1. [【Golang源码系列】一：Map实现原理分析](https://mp.weixin.qq.com/s/c_7omM1SocMlPnm8heyj4Q)
2. [Dig101 - Go之读懂map的底层设计](https://zhuanlan.zhihu.com/p/105413496)
3. [golang map原理看这篇就足够了-阿里云开发者社区](https://developer.aliyun.com/article/1270625)
4. [Go-Map底层原理剖析go语言map是一种内置的数据结构，它使用键值对的方式来映射和存储数据，具有O(1)的读写性能。 - 掘金](https://juejin.cn/post/7314509615159935027)

