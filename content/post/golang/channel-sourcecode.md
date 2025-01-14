+++
date = '2024-12-21T09:30:00+08:00'
title = 'Golang的channel和源码分析'
draft = false
categories = ['Golang']
tags = ['channel', '源代码']
+++


`channel` 的底层结构是一个复杂的并发数据结构，包含了缓冲区、等待队列、互斥锁等组件，用于实现`goroutine`之间的安全通信和同步。

Go 语言中的 channel 底层是通过 `hchan` 结构体实现的，`hchan` 结构体的定义和相关操作都位于 `runtime/chan.go` 文件中，以下源代码基于 go1.23.3 版本，有删减。
<!--more-->

### 一、channel 的底层结构

channel涉及到的核心数据结构包含3个，`hchan`、`waitq`、`sudog`。

#### 1.1 hchan

以下是 `hchan` 结构体的定义：

```go
type hchan struct {
    qcount   uint           // 当前 channel 中的数据个数
    dataqsiz uint           // channel 缓冲区的大小
    buf      unsafe.Pointer // 指向缓冲区的指针
    elemsize uint16         // channel 中元素的大小
    closed   uint32         // channel 是否关闭的标志
    elemtype *_type         // channel 中元素的类型
    sendx    uint           // 发送操作的索引
    recvx    uint           // 接收操作的索引
    recvq    waitq          // 接收操作的等待队列
    sendq    waitq          // 发送操作的等待队列
    lock     mutex          // 互斥锁，用于保护 channel 的操作
}
```

`hchan`结构体的主要组成部分有四个：

* **buf**：用来保存goroutine之间传递数据的循环链表。
* **sendx**和**recvx**：用来记录此循环链表当前发送或接收数据的下标值。
* **sendq** 和 **recvq**：用于保存向该chan发送和从该chan接收数据的goroutine的队列。
* **lock**：保证channel写入和读取数据时线程安全的锁。

#### 1.2 waitq

`waitq`是因读写 channel 而陷入阻塞的协程等待队列。

```go
type waitq struct {
    first *sudog    // 队列头部
    last  *sudog    // 队列尾部
}
```

#### 1.3 sudog

`sudog`是协程等待队列的节点。

```go
type sudog struct {
    g *g                // 等待send或recv的协程g

    next *sudog         // 等待队列下一个结点next
    prev *sudog         // 等待队列前一个结点next
    elem unsafe.Pointer // data element (may point to stack)


    acquiretime int64
    releasetime int64
    ticket      uint32

    isSelect bool

    success bool        // 标记协程g被唤醒是因为数据传递(true)还是channel被关闭(false)

    waiters uint16

    parent   *sudog // semaRoot binary tree
    waitlink *sudog // g.waiting list or semaRoot
    waittail *sudog // semaRoot
    c        *hchan // channel
}
```

#### 1.4 hchan图解

![](https://exknk14n7b.feishu.cn/space/api/box/stream/download/asynccode/?code=ZTI5MjgwMTk4ZjRiMGU1NDQ3ZWQxZDA1Y2UzODM3MDBfSVJuZDA2Rmxza1JLT3VNNXlUY1Zqbmg5N1ZiOUI0WHdfVG9rZW46RnJGdWJNQ2tzb01KRDJ4NHRvdmNNR0ZibnRkXzE3MzY4NjczODY6MTczNjg3MDk4Nl9WNA)

**环形缓冲区**

* 如果 channel 是有缓冲的，`hchan` 中的 `buf` 字段会指向一个环形缓冲区（circular buffer），用于存储待发送或待接收的元素。
* `dataqsiz` 表示缓冲区的大小，`qcount` 表示当前缓冲区中的元素数量。
* `sendx` 和 `recvx` 分别表示发送和接收的索引，用于在环形缓冲区中定位下一个要发送或接收的元素。

**等待队列**

**互斥锁**

`lock` 是一个互斥锁，用于保护 channel 的并发访问，确保在同一时间只有一个 goroutine 可以修改 channel 的状态。

### 二、channel 的操作

#### 2.1 通道创建

* 创建 channel 时，会根据 channel 的类型（有缓冲或无缓冲）分配相应的内存，并初始化 `hchan` 结构体。对于无缓冲 channel，缓冲区大小为 0，而对于有缓冲 `channel`，则会分配相应大小的缓冲区。
* 创建过程包括分配 `hchan` 结构体的内存、初始化互斥锁、设置缓冲区大小和元素类型等。

源代码定义了一个 `makechan` 函数，该函数用于创建一个新的 channel。下面是对这段代码的逐行分析：

1. **函数签名**：

```go
func makechan(t *chantype, size int) *hchan {}
```

`makechan` 函数接收两个参数：

2. **元素大小检查**：

```go
elem := t.Elem

// compiler checks this but be safe.
if elem.Size_ >= 1<<16 {
    throw("makechan: invalid channel element type")
}
```

这里获取了 channel 元素的类型信息，并检查元素大小是否超过了 1<<16（即 65536 字节）。如果超过，抛出异常，因为 Go 语言的 channel 不支持这么大的元素。

3. **对齐和大小检查**：

```go
if hchanSize%maxAlign != 0 || elem.Align_ > maxAlign {
    throw("makechan: bad alignment")
}
```

检查 `hchan` 结构体的大小是否满足最大对齐要求，以及元素的对齐要求是否超过了最大对齐要求。如果不满足，同样抛出异常。

4. **内存分配检查**：

```go
mem, overflow := math.MulUintptr(elem.Size_, uintptr(size))
if overflow || mem > maxAlloc-hchanSize || size < 0 {
    panic(plainError("makechan: size out of range"))
}
```

计算所需的内存大小（元素大小乘以容量），并检查是否发生了溢出，或者所需内存加上 `hchan` 结构体的大小超过了最大分配限制，或者容量小于 0。如果这些检查失败，触发 panic。

5. **内存分配策略**：

```go
var c *hchan
switch {
case mem == 0:
    // Queue or element size is zero.
    c = (*hchan)(mallocgc(hchanSize, nil, true))
    // Race detector uses this location for synchronization.
    c.buf = c.raceaddr()
case !elem.Pointers():
    // Elements do not contain pointers.
    // Allocate hchan and buf in one call.
    c = (*hchan)(mallocgc(hchanSize+mem, nil, true))
    c.buf = add(unsafe.Pointer(c), hchanSize)
default:
    // Elements contain pointers.
    c = new(hchan)
    c.buf = mallocgc(mem, elem, true)
}
```

根据元素是否包含指针和所需内存大小，选择不同的内存分配策略：

* 如果内存大小为 0（无缓冲 channel 或元素大小为 0），分配 `hchan` 结构体的内存，并设置 `buf` 为 `hchan` 结构体内部的 `raceaddr` 字段，用于竞态检测。
* 如果元素不包含指针，将 `hchan` 结构体和缓冲区一起分配。
* 如果元素包含指针，先分配 `hchan` 结构体，然后单独分配缓冲区的内存。

channel 本身是引用类型，其创建全部调用的是 `mallocgc()`，在堆上开辟的内存空间，说明 channel 本身会被 GC 自动回收。

6. **初始化 `hchan`**&#x7ED3;构体：

```go
c.elemsize = uint16(elem.Size_)
c.elemtype = elem
c.dataqsiz = uint(size)
lockInit(&c.lock, lockRankHchan)
```

初始化 `hchan` 结构体的字段，包括元素大小、元素类型、缓冲区大小，并初始化互斥锁。

#### 2.2 向通道发送数据

* 如果 `channel` 的缓冲区未满，发送操作会将元素放入缓冲区并更新 `sendx` 和 `qcount`。
* 如果缓冲区已满，发送操作会将当前`goroutine`加入 `sendq` 队列并阻塞，直到有接收者接收数据。

源代码定义了一个 `chansend` 函数，该函数用于向 channel 发送数据。下面是对这段代码的逐行分析：

1. **函数签名**：

```go
func chansend(c *hchan, ep unsafe.Pointer, block bool, callerpc uintptr) bool {}
```

`chansend` 函数接收四个参数：

* `c` 是一个指向 `hchan` 的指针，表示要发送数据的 channel。
* `ep` 是一个 `unsafe.Pointer` 类型，指向要发送的数据。
* `block` 是一个布尔值，表示是否阻塞发送操作。
* `callerpc` 是调用者的程序计数器，用于调试和竞态检测。

2. **检查 channel 是否为空**：

```go
if c == nil {
    if !block {
        return false
    }
    gopark(nil, nil, waitReasonChanSendNilChan, traceBlockForever, 2)
    throw("unreachable")
}
```

如果 channel 为空，并且 `block` 为 `false`，则返回 `false`。如果 `block` 为 `true`，则调用 `gopark` 函数使当前 goroutine 进入等待状态，并抛出异常（理论上不会执行到这里）。

3. **竞态检测**：

```go
if raceenabled {
    racereadpc(c.raceaddr(), callerpc, abi.FuncPCABIInternal(chansend))
}
```

如果启用了竞态检测，记录当前 goroutine 的状态。

4. **快速路径**：

```go
if !block && c.closed == 0 && full(c) {
    return false
}
```

如果不阻塞并且 channel 未关闭，但缓冲区已满，则返回 `false`。

5. **计时器**：

```go
var t0 int64
if blockprofilerate > 0 {
    t0 = cputicks()
}
```

如果启用了阻塞分析，记录当前时间。

6. **加锁**：

```go
lock(&c.lock)
```

加锁以保护 channel 的状态。

7. **检查 channel 是否关闭**：

```go
if c.closed != 0 {
    unlock(&c.lock)
    panic(plainError("send on closed channel"))
}
```

如果 channel 已关闭，解锁并抛出异常。

8. **发送给等待的接收者**：

```go
if sg := c.recvq.dequeue(); sg != nil {
    send(c, sg, ep, func() { unlock(&c.lock) }, 3)
    return true
}
```

如果有等待的接收者，直接将数据发送给接收者，绕过缓冲区。

9. **缓冲区发送**：

```go
if c.qcount < c.dataqsiz {
    qp := chanbuf(c, c.sendx)
    if raceenabled {
        racenotify(c, c.sendx, nil)
    }
    typedmemmove(c.elemtype, qp, ep)
    c.sendx++
    if c.sendx == c.dataqsiz {
        c.sendx = 0
    }
    c.qcount++
    unlock(&c.lock)
    return true
}
```

如果缓冲区有空间，将数据放入缓冲区。

10. **非阻塞发送**：

```go
if !block {
    unlock(&c.lock)
    return false
}
```

如果不阻塞并且缓冲区已满，解锁并返回 `false`。

11. **阻塞发送**：

```go
gp := getg()
mysg := acquireSudog()
mysg.releasetime = 0
if t0 != 0 {
    mysg.releasetime = -1
}
mysg.elem = ep
mysg.waitlink = nil
mysg.g = gp
mysg.isSelect = false
mysg.c = c
gp.waiting = mysg
gp.param = nil
c.sendq.enqueue(mysg)
gp.parkingOnChan.Store(true)
gopark(chanparkcommit, unsafe.Pointer(&c.lock), waitReasonChanSend, traceBlockChanSend, 2)
KeepAlive(ep)
```

如果阻塞，将当前 goroutine 加入发送队列，并调用 `gopark` 函数使当前 goroutine 进入等待状态。

12. **唤醒**：

```go
if mysg != gp.waiting {
    throw("G waiting list is corrupted")
}
gp.waiting = nil
gp.activeStackChans = false
closed := !mysg.success
gp.param = nil
if mysg.releasetime > 0 {
    blockevent(mysg.releasetime-t0, 2)
}
mysg.c = nil
releaseSudog(mysg)
if closed {
    if c.closed == 0 {
        throw("chansend: spurious wakeup")
    }
    panic(plainError("send on closed channel"))
}
return true
```

当有接收者接收数据时，唤醒发送者。检查 channel 是否关闭，并返回发送结果。

#### 2.3 从通道接收数据

如果 `channel` 的缓冲区不为空，接收操作会从缓冲区中取出元素并更新 `recvx` 和 `qcount`。  
如果缓冲区为空，接收操作会将当前`goroutine`加入 `recvq` 队列并阻塞，直到有发送者发送数据。  
源代码实现了 `chanrecv` 函数，该函数用于从 channel 接收数据。下面是对这段代码的逐行分析：

1. **函数签名**：

```go
func chanrecv(c *hchan, ep unsafe.Pointer, block bool) (selected, received bool)
```

`chanrecv` 函数接收三个参数：

* `c` 是一个指向 `hchan` 的指针，表示要接收数据的 channel。
* `ep` 是一个 `unsafe.Pointer` 类型，指向接收数据的内存位置。
* `block` 是一个布尔值，表示是否阻塞接收操作。

函数返回两个布尔值：`selected` 和 `received`，分别表示是否选择了该 channel 进行操作（在多路复用场景中）和是否成功接收到数据。

2. **检查 channel 是否为空**：

```go
if c == nil {
    if !block {
        return
    }
    gopark(nil, nil, waitReasonChanReceiveNilChan, traceBlockForever, 2)
    throw("unreachable")
}
```

如果 channel 为空，并且 `block` 为 `false`，则返回。如果 `block` 为 `true`，则调用 `gopark` 函数使当前 goroutine 进入等待状态，并抛出异常（理论上不会执行到这里）。

3. **检查 channel 的定时器**：

```go
if c.timer != nil {
    c.timer.maybeRunChan()
}
```

如果 channel 有定时器，检查并可能运行定时器。

4. **快速路径**：

```go
if !block && empty(c) {
    if atomic.Load(&c.closed) == 0 {
        return
    }
    if empty(c) {
        if raceenabled {
            raceacquire(c.raceaddr())
        }
        if ep != nil {
            typedmemclr(c.elemtype, ep)
        }
        return true, false
    }
}
```

如果不阻塞并且 channel 为空，则检查 channel 是否关闭。如果关闭，检查缓冲区是否有数据。如果没有数据，则返回 `true, false`。

5. **计时器**：

```go
var t0 int64
if blockprofilerate > 0 {
    t0 = cputicks()
}
```

如果启用了阻塞分析，记录当前时间。

6. **加锁**：

```go
lock(&c.lock)
```

加锁以保护 channel 的状态。

7. **检查 channel 是否关闭**：

```go
if c.closed != 0 {
    if c.qcount == 0 {
        if raceenabled {
            raceacquire(c.raceaddr())
        }
        unlock(&c.lock)
        if ep != nil {
            typedmemclr(c.elemtype, ep)
        }
        return true, false
    }
}
```

如果 channel 已关闭，检查缓冲区是否有数据。如果没有数据，则返回 `true, false`。

8. **从发送队列接收**：

```go
if sg := c.sendq.dequeue(); sg != nil {
    recv(c, sg, ep, func() { unlock(&c.lock) }, 3)
    return true, true
}
```

如果有等待的发送者，直接从发送队列接收数据。

9. **从缓冲区接收**：

```go
if c.qcount > 0 {
    qp := chanbuf(c, c.recvx)
    if raceenabled {
        racenotify(c, c.recvx, nil)
    }
    if ep != nil {
        typedmemmove(c.elemtype, ep, qp)
    }
    typedmemclr(c.elemtype, qp)
    c.recvx++
    if c.recvx == c.dataqsiz {
        c.recvx = 0
    }
    c.qcount--
    unlock(&c.lock)
    return true, true
}
```

如果缓冲区有数据，从缓冲区接收数据。

10. **非阻塞接收**：

```go
if !block {
    unlock(&c.lock)
    return false, false
}
```

如果不阻塞并且缓冲区为空，解锁并返回 `false, false`。

11. **阻塞接收**：

```go
gp := getg()
mysg := acquireSudog()
mysg.releasetime = 0
if t0 != 0 {
    mysg.releasetime = -1
}
mysg.elem = ep
mysg.waitlink = nil
gp.waiting = mysg

mysg.g = gp
mysg.isSelect = false
mysg.c = c
gp.param = nil
c.recvq.enqueue(mysg)
if c.timer != nil {
    blockTimerChan(c)
}

gp.parkingOnChan.Store(true)
gopark(chanparkcommit, unsafe.Pointer(&c.lock), waitReasonChanReceive, traceBlockChanRecv, 2)

if mysg != gp.waiting {
    throw("G waiting list is corrupted")
}
if c.timer != nil {
    unblockTimerChan(c)
}
gp.waiting = nil
gp.activeStackChans = false
if mysg.releasetime > 0 {
    blockevent(mysg.releasetime-t0, 2)
}
success := mysg.success
gp.param = nil
mysg.c = nil
releaseSudog(mysg)
return true, success
```

如果阻塞，将当前 goroutine 加入接收队列，并调用 `gopark` 函数使当前 goroutine 进入等待状态。

12. **唤醒**：

```go
if mysg != gp.waiting {
    throw("G waiting list is corrupted")
}
if c.timer != nil {
    unblockTimerChan(c)
}
gp.waiting = nil
gp.activeStackChans = false
if mysg.releasetime > 0 {
    blockevent(mysg.releasetime-t0, 2)
}
success := mysg.success
gp.param = nil
mysg.c = nil
releaseSudog(mysg)
return true, success
```

当有发送者发送数据时，唤醒接收者。检查接收是否成功，并返回结果。

#### 2.4 通道关闭

* 关闭 `channel` 会设置 `closed` 标志，并唤醒所有等待的`goroutine`（发送者和接收者）。
* 关闭后的 `channel` 不能再发送数据，但可以继续接收数据，直到缓冲区为空。

源代码实现了 `closechan` 函数，该函数用于关闭一个 channel。关闭 channel 是一个重要的操作，它通知所有等待在该 channel 上的 goroutine， channel 已经关闭，不能再进行发送或接收操作。下面是对这段代码的逐行分析：

1. **检查 Channel 是否为空**：

```go
if c == nil {
    panic(plainError("close of nil channel"))
}
```

如果 channel 为空，抛出异常，因为不能关闭一个空的 channel。

2. **加锁**：

```go
lock(&c.lock)
```

获取 channel 的互斥锁，以确保对 channel 状态的修改是原子操作。

3. **检查 Channel 是否已关闭**：

```go
if c.closed != 0 {
    unlock(&c.lock)
    panic(plainError("close of closed channel"))
}
```

如果 channel 已经关闭，解锁并抛出异常，因为不能重复关闭一个 channel。

4. **竞态检测**：

```go
if raceenabled {
    callerpc := getcallerpc()
    racewritepc(c.raceaddr(), callerpc, abi.FuncPCABIInternal(closechan))
    racerelease(c.raceaddr())
}
```

如果启用了数据竞争检测，记录当前 goroutine 的状态，并标记 channel 的内存位置为“已释放”。

5. **标记 Channel 为已关闭**：

```go
c.closed = 1
```

将 channel 的 `closed` 字段设置为 1，表示 channel 已经关闭。

6. **唤醒所有接收者**：

```go
var glist gList
for {
    sg := c.recvq.dequeue()
    if sg == nil {
        break
    }
    if sg.elem != nil {
        typedmemclr(c.elemtype, sg.elem)
        sg.elem = nil
    }
    if sg.releasetime != 0 {
        sg.releasetime = cputicks()
    }
    gp := sg.g
    gp.param = unsafe.Pointer(sg)
    sg.success = false
    if raceenabled {
        raceacquireg(gp, c.raceaddr())
    }
    glist.push(gp)
}
```

从接收队列中逐个取出等待的 goroutine，并执行以下操作：
* 清除接收数据的内存位置。
* 记录当前时间（如果需要）。
* 设置 goroutine 的参数和状态。
* 如果启用了竞态检测，标记 goroutine 的状态。
* 将 goroutine 添加到 `glist` 列表中。

7. **唤醒所有发送者**：

```go
for {
    sg := c.sendq.dequeue()
    if sg == nil {
        break
    }
    sg.elem = nil
    if sg.releasetime != 0 {
        sg.releasetime = cputicks()
    }
    gp := sg.g
    gp.param = unsafe.Pointer(sg)
    sg.success = false
    if raceenabled {
        raceacquireg(gp, c.raceaddr())
    }
    glist.push(gp)
}
```

从发送队列中逐个取出等待的 goroutine，并执行类似的操作。

8. **解锁**：

```go
unlock(&c.lock)
```

释放互斥锁。

9. **准备好所有 Goroutine**：

```go
for !glist.empty() {
    gp := glist.pop()
    gp.schedlink = 0
    goready(gp, 3)
}
```

遍历 `glist` 列表，将每个 goroutine 设置为就绪状态，以便它们可以继续执行。

### 三、小结

#### 3.1 有缓冲 channel 和无缓冲 channel 的对比

| 特性/操作 | 有缓冲的 channel                                                         | 无缓冲的 channel                                        |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------- |
| 缓冲区   | 包含一个固定大小的缓冲区，用作环形队列。                                                 | 不包含缓冲区，`buf` 字段为 `nil`。                             |
| 发送数据  | 数据被写入缓冲区的 `sendx` 位置，然后 `sendx` 索引增加并循环。                             | 发送方 goroutine 被加入 `sendq` 队列，如果接收方不存在或不可立即接收则阻塞。    |
| 接收数据  | 从 `recvx` 位置读取数据，然后 `recvx` 索引增加并循环。当 `recvx` 与 `sendx` 相等时，表示缓冲区为空。 | 从 `sendq` 队列中取出等待的发送方 goroutine 并接收其数据，如果发送方不存在则阻塞。 |
| 同步性   | 异步传输数据，发送和接收操作不需要同时发生。                                               | 同步传输数据，发送和接收操作必须同时发生。                               |
| 阻塞行为  | 发送方仅在缓冲区满时阻塞；接收方仅在缓冲区空时阻塞。                                           | 发送方在没有接收方时阻塞；接收方在没有发送方时阻塞。                          |
| 使用场景  | 适用于生产者和消费者之间速率不匹配，需要缓冲区平滑处理的场景。                                      | 适用于需要确保发送和接收严格同步的场景，如信号量或事件通知。                      |
| 性能特点  | 可以减少因同步等待导致的上下文切换，但可能会增加内存使用。                                        | 上下文切换可能更频繁，但不需要额外的缓冲区内存。                            |

#### 3.2 对 nil / 已关闭的/有数据的 channel 进行读写和关闭操作

| 操作\Channel类型 | Nil Channel | 已关闭的 Channel               | 有数据的 Channel                                             |
| ------------ | ----------- | -------------------------- | -------------------------------------------------------- |
| 写入           | panic       | panic                      | 成功（如果缓冲区未满）阻塞（如果缓冲区满）                                    |
| 读取           | panic       | 可能成功（如果缓冲区有数据）返回零值（如果缓冲区空） | 成功（如果缓冲区有数据）阻塞（如果缓冲区空且channel未关闭）返回零值（如果缓冲区空且channel已关闭） |
| 关闭           | panic       | panic                      | 成功（唤醒等待的goroutine）                                       |

需要注意的是，对于已关闭的 channel，读取操作可能成功，这取决于缓冲区中是否还有数据。  
对于有数据的 channel，关闭操作是安全的，并且会处理缓冲区中剩余的数据。




参考链接：

1. [从鹅厂实例出发！分析Go Channel底层原理](https://segmentfault.com/a/1190000042927699)
2. [Golang channel底层是如何实现的?(深度好文) - golang架构师k哥 - 博客园](https://www.cnblogs.com/killianxu/p/18286611)
