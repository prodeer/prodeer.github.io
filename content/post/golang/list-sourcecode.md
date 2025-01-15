+++
date = '2024-12-30T19:30:00+08:00'
title = 'Golang的list和源码分析'
draft = false
mermaid = true
categories = ['Golang']
tags = ['Golang', '双向链表', '源代码']
+++

刷力扣时，有这样一道题，要求**设计并实现一个满足  LRU (最近最少使用) 缓存约束的数据结构**，实现这道题用到了Go 官方库提供的`container/list`包中的List（双向链表）。
<!--more-->

### 一、container/list的常用API
Go语言中的`container/list`包提供了一个双向链表的实现，它适用于需要频繁插入和删除操作的场景。以下是`container/list`包中一些常用的API和操作方法：

### 创建链表

* `list.New()`：创建一个新的双向链表。

### 添加元素

* `PushFront(v interface{}) *Element`：在链表的前端插入一个新的元素，并返回该元素。
* `PushBack(v interface{}) *Element`：在链表的后端插入一个新的元素，并返回该元素。
* `InsertBefore(v interface{}, mark *Element) *Element`：在指定元素`mark`之前插入一个新的元素。
* `InsertAfter(v interface{}, mark *Element) *Element`：在指定元素`mark`之后插入一个新的元素。

### 删除元素

* `Remove(e *Element) interface{}`：从链表中移除元素`e`，并返回该元素的值。

### 遍历链表

* `Front() *Element`：返回链表的第一个元素。
* `Back() *Element`：返回链表的最后一个元素。

### 其他操作

* `Len() int`：返回链表中元素的数量。
* `MoveToFront(e *Element)`：将元素`e`移动到链表的前端。
* `MoveToBack(e *Element)`：将元素`e`移动到链表的后端。

### 二、源码分析

Go 中`container/list`的相关部分可以在源码下的 `src/container/list/list.go` 查看。以下源代码基于 go1.23.3 版本，有删减。

#### 2.1 Element 结构体

```go
// Element is an element of a linked list.
type Element struct {
    // Next and previous pointers in the doubly-linked list of elements.
    // To simplify the implementation, internally a list l is implemented
    // as a ring, such that &l.root is both the next element of the last
    // list element (l.Back()) and the previous element of the first list
    // element (l.Front()).
    next, prev *Element

    // The list to which this element belongs.
    list *List

    // The value stored with this element.
    Value any
}
```

每个节点（`Element`）包含指向前一个节点和后一个节点的指针（`prev`和`next`），一个指向它所属链表（`list`）的指针，以及存储的值（`Value`）。  
这种设计允许节点在链表中正确地定位自己，并且可以安全地进行插入和删除操作。

#### 2.2 List 结构体

```go
// List represents a doubly linked list.
// The zero value for List is an empty list ready to use.
type List struct {
    root Element // sentinel list element, only &root, root.prev, and root.next are used
    len  int     // current list length excluding (this) sentinel element
}

// Init initializes or clears list l.
func (l *List) Init() *List {
    l.root.next = &l.root
    l.root.prev = &l.root
    l.len = 0
    return l
}
```

`List`结构体包含一个哨兵节点（`root`），以及链表的长度（`len`）。其中，哨兵节点不存储数据。  
`Init()`方法用于初始化或清空链表。在这个方法中，`root.next`和`root.prev`被设置为`&l.root`，确保了哨兵节点的`next`和`prev`指针都指向自己，形成了环形结构。

{{< mermaid bc="#white" >}}
graph LR
    root(("root/sential node"))
    headNode1["Head Node"]
    headNode2["Node"]
    tailNode["Tail Node"]
    
    root -->|next| headNode1
    headNode1 -->|next| headNode2
    headNode2 -->|next| tailNode
    
    tailNode -->|prev| headNode2
    headNode2 -->|prev| headNode1
    headNode1 -->|prev| root

    tailNode -->|prev| root
    root -->|next| tailNode
{{< /mermaid >}}

哨兵节点作为链表的起始和结束节点，其`next`和`prev`指针都指向自己，这种设计避免了对空链表的特殊处理，使得链表的插入和删除操作更加统一和简化。

#### 2.3 延迟初始化

```go
// lazyInit lazily initializes a zero List value.
func (l *List) lazyInit() {
    if l.root.next == nil {
       l.Init()
    }
}
```

当通过`list.New()`创建一个新的链表实例时，链表已经被初始化，其哨兵节点（`root`）的`next`和`prev`指针都指向自己，形成一个环形结构，且链表长度（`len`）为0。然而，如果链表是通过`list.List{}`直接声明的，那么它可能还没有被初始化。

`lazyInit`是一个用于延迟初始化列表的方法，在这段代码中，`lazyInit`首先检查`root.next`是否为`nil`，如果是，则调用`Init()`方法。`Init()`方法将`root.next`和`root.prev`都设置为`&l.root`，形成一个自环，并将长度`len`设置为0。这个过程确保了链表在第一次使用前是准备好的，即使它在声明时没有被显式初始化。

`lazyInit`方法的作用是检查链表是否已经初始化。如果还没有初始化（即`root.next`为`nil`），则调用`Init()`方法进行初始化。这样，只有在实际需要对链表进行操作时，才会进行初始化，从而节省资源。

#### 2.4 insert 插入

```go
// insert inserts e after at, increments l.len, and returns e.
func (l *List) insert(e, at *Element) *Element {
    e.prev = at
    e.next = at.next
    e.prev.next = e
    e.next.prev = e
    e.list = l
    l.len++
    return e
}

// insertValue is a convenience wrapper for insert(&Element{Value: v}, at).
func (l *List) insertValue(v any, at *Element) *Element {
    return l.insert(&Element{Value: v}, at)
}
```

插入操作通过`insert`函数实现，该函数将一个新元素`e`插入到指定元素`at`之后。具体步骤如下：
1. 设置新元素`e`的前驱指针`prev`指向`at`。
2. 设置新元素`e`的后继指针`next`指向`at.next`。
3. 更新`at`的后继节点的前驱指针`prev`指向新元素`e`。
4. 更新`at.next`的前驱节点的后继指针`next`指向新元素`e`。
5. 将新元素`e`的`list`指针指向当前列表`l`，以确保元素与列表的关联。
6. 增加列表`l`的长度`len`。

#### 2.5 remove 删除

```go
// remove removes e from its list, decrements l.len
func (l *List) remove(e *Element) {
    e.prev.next = e.next
    e.next.prev = e.prev
    e.next = nil // avoid memory leaks
    e.prev = nil // avoid memory leaks
    e.list = nil
    l.len--
}

// Remove removes e from l if e is an element of list l.
// It returns the element value e.Value.
// The element must not be nil.
func (l *List) Remove(e *Element) any {
    if e.list == l {
       // if e.list == l, l must have been initialized when e was inserted
       // in l or l == nil (e is a zero Element) and l.remove will crash
       l.remove(e)
    }
    return e.Value
}
```

删除操作通过`remove`函数实现，该函数从列表中移除指定元素`e`。具体步骤如下：
1. 更新`e.prev`的后继指针`next`指向`e.next`，从而跳过`e`。
2. 更新`e.next`的前驱指针`prev`指向`e.prev`，同样跳过`e`。
3. 将`e`的后继和前驱指针设置为`nil`，以避免内存泄漏。
4. 将`e`的`list`指针设置为`nil`，解除与列表的关联。
5. 减少列表`l`的长度`len`。

#### 2.6 move 移动

```go
// move moves e to next to at.
func (l *List) move(e, at *Element) {
    if e == at {
       return
    }
    e.prev.next = e.next
    e.next.prev = e.prev

    e.prev = at
    e.next = at.next
    e.prev.next = e
    e.next.prev = e
}
```

移动操作通过`move`函数实现，该函数将元素`e`移动到另一个元素`at`的旁边。具体步骤如下：
1. 首先执行删除操作，从当前位置移除`e`。
2. 然后将`e`插入到新位置，即`at`的前驱或后继位置，这取决于移动的方向（前或后）。
3. 移动操作不会改变列表的长度，因为元素`e`仍然在列表中。

通过直接操作节点的前驱和后继指针，`container/list`在需要频繁修改数据结构的场景下，可以在O(1)的时间复杂度内完成插入、删除和移动操作。

### 三、实现一个LRU缓存

回到开头的题，设计并实现一个满足  LRU (最近最少使用) 缓存，代码如下：

```go
type entry struct {
    key   int 
    value int
}

type LRUCache struct {
    capacity  int
    list      *list.List // 双向链表
    keyToNode map[int]*list.Element
}

func Constructor(capacity int) LRUCache {
    return LRUCache{capacity, list.New(), map[int]*list.Element{}}
}

func (c *LRUCache) Get(key int) int {
    node := c.keyToNode[key]
    if node == nil {
        return -1
    }
    c.list.MoveToFront(node) 
    return node.Value.(entry).value
}

func (c *LRUCache) Put(key, value int) {
    if node := c.keyToNode[key]; node != nil { 
        node.Value = entry{key, value}
        c.list.MoveToFront(node) 
        return
    }
    c.keyToNode[key] = c.list.PushFront(entry{key, value}) 
    if len(c.keyToNode) > c.capacity { 
        delete(c.keyToNode, c.list.Remove(c.list.Back()).(entry).key) 
    }
}
```

参考链接：  
1. [Golang标准库 container/list(双向链表) 的图文解说 - 画个一样的我 - 博客园](https://www.cnblogs.com/huageyiyangdewo/p/17934882.html)
2. [146. LRU 缓存 - 力扣（LeetCode）-灵神题解](https://leetcode.cn/problems/lru-cache/solutions/2456294/tu-jie-yi-zhang-tu-miao-dong-lrupythonja-czgt)