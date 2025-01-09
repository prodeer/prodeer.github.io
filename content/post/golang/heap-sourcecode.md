+++
date = '2023-03-04T21:30:00+08:00'
title = 'Golang的heap和源码分析'
draft = false
categories = ['Golang']
tags = ['优先队列', '源代码']
+++

之前用Go实现延时队列，我使用了Go标准库中的`container/heap`接口来构建一个优先队列。为什么Go的`container/heap`接口可以实现一个优先队列呢？

这是因为Go的`container/heap`定义了一套完整的方法，使得任何实现了这些方法的数据结构都能够作为堆来使用。优先队列是堆的一种应用，它允许快速访问最高（或最低）优先级的元素。

<!--more-->

## 一、container/heap介绍

以下是`container/heap`接口实现优先队列的关键点：

1. **定义数据结构**：首先，需要定义一个数据结构来存储堆中的元素。
2. **实现heap.Interface**：`container/heap`接口要求实现以下方法：

```go
Len()：返回堆中元素的数量。
Less(i, j int) bool：比较索引为 i 和 j 的两个元素，确定它们在堆中的顺序。
Swap(i, j int)：交换索引为 i 和 j 的两个元素。
Push(x interface{})：向堆中添加一个新元素。
Pop() interface{}：移除并返回堆中的最后一个元素，即优先级最高的元素。
```
3. **初始化堆**：使用`heap.Init()`函数初始化堆，确保堆的性质得到满足。
4. **操作堆**：通过`heap.Push()`和`heap.Pop()`来添加和移除元素，这些操作会保持堆的性质。
5. **更新元素**：如果需要更新堆中的元素，可以使用`heap.Fix()`来重新调整堆，确保堆的性质不被破坏。

利用`container/heap`接口的灵活性，可以根据具体需求实现不同类型的优先队列，例如最小堆或最大堆。通过实现`Less`方法，可以定义元素之间的比较逻辑，从而控制优先级队列的行为。例如，如果要实现一个最大堆，可以在`Less`方法中使用大于号（`>`）来比较元素，使得优先级最高的元素总是在堆的顶部。

此外，`container/heap`还提供了一些辅助函数，如`heap.Push`, `heap.Pop`, `heap.Remove`, 和 `heap.Fix`，使用这些函数可以更容易地实现和维护优先队列。

## 二、heap源码剖析

Go 中`heap`的相关部分可以在源码下的 `src/container/heap/heap.go` 查看。以下源代码基于 go1.23.3 版本，有删减。

### 2.1 核心接口

```go
type Interface interface {
    sort.Interface
    Push(x any) // add x as element Len()
    Pop() any   // remove and return element Len() - 1.
}
```

这个接口继承了`sort.Interface`接口，同时要求实现`Push`、`Pop`两个方法。`sort.Interface`的定义如下：

```go
type Interface interface {
    // Len is the number of elements in the collection.
    Len() int

    // Less reports whether the element with index i
    // must sort before the element with index j.
    Less(i, j int) bool

    // Swap swaps the elements with indexes i and j.
    Swap(i, j int)
}
```

`sort.Interface` 的定义，主要是三个方法：
* Len ：返回数据集的长度；
* Less ：返回 i 是否小于 j；
* Swap ：交换 i 和 j 的值；

换言之，如果要使用go标准库提供的`heap`，必须自己实现这些接口定义的方法，即`Push`、`Pop`、`Len`、`Less`、`Swap`。

### 2.2 Push

`Push`实现了 “从下到上”的堆化。

```go
func Push(h Interface, x interface{}) {
    h.Push(x) // 向数据集添加一个元素
    up(h, h.Len()-1) // 从下向上堆化
}

// 从下向上堆化的内容
func up(h Interface, j int) {
    for {
        // 计算当前节点j的父节点索引
        i := (j - 1) / 2 // parent
        // 如果两个元素相等 或者 父元素小于当前元素
        if i == j || !h.Less(j, i) {
            break  // 堆化完成
        }
        // 如果当前元素小于父元素，交换父元素和当前元素
        h.Swap(i, j)
        // 更新j为新的父节点索引，继续上移过程
        j = i
    }
}
```

`up`这个函数会将一个节点与它的父节点比较，如果它比父节点小（在最小堆中），就与父节点交换位置，然后继续这个过程，直到节点不再违反堆的性质或者它已经是根节点。

### 2.3 Pop

再来看`Pop`的源码：

```go
func Pop(h Interface) any {
    n := h.Len() - 1    // 获取最终堆长度（去掉最后一个元素）
    h.Swap(0, n)        // 交换堆顶和最后一个元素
    down(h, 0, n)       // 从上到下堆化
    return h.Pop()      // 弹出最后一个元素
}

func down(h Interface, i0, n int) bool {
    i := i0 // 设置当前节点索引为传入的索引i0
    for {
        j1 := 2*i + 1 // 计算左孩子节点的索引
        // 如果左孩子索引j1大于或等于n（堆的元素数量），或者小于0（整数溢出的情况），则退出循环
        if j1 >= n || j1 < 0 {
            break
        }
        j := j1 // 初始化j为左孩子索引
        // 如果右孩子节点存在（j2 < n），并且右孩子比左孩子小，那么将j设置为右孩子的索引
        if j2 := j1 + 1; j2 < n && h.Less(j2, j1) {
            j = j2 // 选择较小的孩子节点
        }
        // 如果当前节点i不小于孩子节点j（即不需要下移），则退出循环
        if !h.Less(j, i) {
            break
        }
        h.Swap(i, j) // 交换当前节点i和孩子节点j的位置
        i = j // 更新当前节点索引为下移的孩子节点索引
    }
    // 如果最终的i大于初始的i0，说明节点下移了，返回true；否则返回false
    return i > i0
}
```

`down`这个函数会将一个节点与它的子节点比较，如果它比子节点大，就与子节点交换位置，然后继续这个过程，直到节点不再违反堆的性质或者它已经是叶子节点。

### 2.4 初始化

根据堆的特性可知，叶子节点不可以从上到下堆化。所以，我们找到最后非叶子节点的索引值，从这里开始做堆化操作。即调用`Init`方法，初始化堆，生成小根(大根)堆。

`Init`方法源码如下:

```go
func Init(h Interface) {
    // heapify
    n := h.Len()
    // i = 最后一个非叶子节点的 index； i >= 堆顶； index 自减
    for i := n/2 - 1; i >= 0; i-- {
        // 从当前节点开始，从上到下堆化
        down(h, i, n)
    }
}
```

初始化一个数组堆的方法就是从数组的中间往前，对每个元素进行一次下沉的操作。

## 三、实现优先队列

```go
package main

import (
    "container/heap"
    "fmt"
)

// 定义优先级队列的元素类型
type Item struct {
    value    string // 元素的值
    priority int    // 元素的优先级
    index    int    // 元素在堆中的索引，用于维护堆的性质
}

// 定义优先级队列，它是一个Item的切片
type PriorityQueue []*Item

// 实现heap.Interface的Len方法，返回优先级队列的长度
func (pq PriorityQueue) Len() int { return len(pq) }

// 实现heap.Interface的Less方法，比较两个元素的优先级
func (pq PriorityQueue) Less(i, j int) bool {
    return pq[i].priority < pq[j].priority // 优先级越小，值越小
}

// 实现heap.Interface的Swap方法，交换两个元素的位置
func (pq PriorityQueue) Swap(i, j int) {
    pq[i], pq[j] = pq[j], pq[i]
    pq[i].index = i
    pq[j].index = j
}

// 实现heap.Interface的Push方法，向优先级队列中添加新元素
func (pq *PriorityQueue) Push(x interface{}) {
    n := len(*pq)
    item := x.(*Item)
    item.index = n // 设置新元素的索引
    *pq = append(*pq, item)
}

// 实现heap.Interface的Pop方法，从优先级队列中移除并返回优先级最高的元素
func (pq *PriorityQueue) Pop() interface{} {
    old := *pq
    n := len(old)
    item := old[n-1]
    item.index = -1 // 删除元素，设置其索引为-1
    *pq = old[0 : n-1]
    return item
}

// 用于维护堆的性质，上移操作
func (pq *PriorityQueue) up(i int) {
    for {
        pi := (i - 1) / 2 // 计算父节点索引
        if pi == i || !pq.Less(i, pi) {
            break
        }
        pq.Swap(i, pi)
        i = pi
    }
}

// 用于维护堆的性质，下移操作
func (pq *PriorityQueue) down(i0 int, n int) bool {
    i := i0
    for {
        j1 := 2*i + 1
        if j1 >= n || j1 < 0 { // j1 < 0 after int overflow
            break
        }
        j := j1
        if j2 := j1 + 1; j2 < n && pq.Less(j2, j1) {
            j = j2
        }
        if !pq.Less(j, i) {
            break
        }
        pq.Swap(i, j)
        i = j
    }
    return i > i0
}

func main() {
    pq := &PriorityQueue{}
    heap.Init(pq)

    // 添加元素到优先级队列
    heap.Push(pq, &Item{value: "A", priority: 2})
    heap.Push(pq, &Item{value: "B", priority: 1})
    heap.Push(pq, &Item{value: "C", priority: 3})

    // 打印优先级队列
    for pq.Len() > 0 {
        fmt.Printf("%+v ", heap.Pop(pq))
    }
}
```
定义了一个Item结构体来表示优先级队列中的元素，它包含元素的值、优先级和一个索引。
PriorityQueue是一个Item的切片，实现了heap.Interface接口。
使用heap.Init()初始化优先级队列，然后使用heap.Push()添加元素，最后使用heap.Pop()移除并打印元素。