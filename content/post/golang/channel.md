+++
date = '2021-08-24T01:46:00+08:00'
title = 'Go的Channel发送和接收'
draft = false
categories = ['Golang']
tags = ['Golang', '源代码']
+++

先来看一道面试题：
```
对已经关闭的 chan 进行读写，会怎么样？为什么？
```
在上一篇学习 Go 协程的文章中，知道 go 关键字可以用来开启一个 goroutine 进行任务处理，但多个任务之间如果需要通信，就需要用到通道（channel）了。

#### 一、Channel的定义
声明并初始化一个通道，可以使用 Go 语言的内建函数 `make`，同时指定该通道类型的元素类型，下面声明了一个 chan int 类型的 channel:
```
ch := make(chan int)
```

#### 二、Channel的操作
**发送（写）**：发送操作包括了“复制元素值”和“放置副本到通道内部”这两个步骤。即：进入通道的并不是操作符右边的那个元素值，而是它的副本。
```
ch := make(chan int)

// write to channel
ch <- x
```

**接收（读）**：接收操作包含了“复制通道内的元素值”、“放置副本到接收方”、“删掉原值”三个步骤。
```
ch := make(chan int)

// read from channel
x <- ch

// another way to read
x = <- ch
```

**关闭**：关闭 channel 会产生一个广播机制，所有向 channel 读取消息的 goroutine 都会收到消息。
```
ch := make(chan int)

close(ch)
```
从一个已关闭的 channel 中读取消息永远不会阻塞，并且会返回一个为 false 的 ok-idiom，可以用它来判断 channel 是否关闭：
```
v, ok := <-ch
```
如果 ok 是false，表明接收的 v 是产生的零值，这个 channel 被关闭了或者为空。

#### 三、Channel发送和接收操作的特点
1. **一个通道相当于一个先进先出（FIFO）的队列**：也就是说，通道中的各个元素值都是严格地按照发送的顺序排列的，先被发送通道的元素值一定会先被接收。

2. **对于同一个通道，发送操作之间和接收操作之间是互斥的**：同一时刻，对同一通道发送多个元素，直到这个元素值被完全复制进该通道之后，其他针对该通道的发送操作才可能被执行。接收也是如此。

3. **发送操作和接收操作中，对元素值的处理是不可分割的**：前面我们知道发送一个值到通道，是先复制值，再将该副本移动到通道内部，“不可分割”指的是发送操作要么还没复制元素值，要么已经复制完毕，绝不会出现只复制了一部分的情况。接收也是同理，在准备好元素值的副本之后，一定会删除掉通道中的原值，绝不会出现通道中仍有残留的情况。

4. **发送操作和接收操作在完全完成之前会被阻塞**：发送操作包括了“复制元素值”和“放置副本到通道内部”这两个步骤。在这两个步骤完全完成之前，发起这个发送操作的那句代码会一直阻塞在那里，在它之后的代码不会有执行的机会，直到阻塞解除。

#### 四、Channel的类型
channel 分为不带缓存的 channel 和带缓存的 channel。

使用 `make` 声明一个通道类型变量时，除了指定通道的元素类型，还可以指定通道的容量，也就是通道最多可以缓存多少个元素值，当容量为 0 时，该通道为非缓冲通道，当容量大于 0 时，该通道为带有缓冲的通道。
```
ch := make(chan int)    //无缓冲的channel
ch := make(chan int, 3) //带缓冲的channel
```
非缓冲通道和缓冲通道有着不同的数据传递方式：

* **非缓冲通道**：无论是发送操作还是接收操作，一开始执行就会被阻塞，直到配对的操作也开始执行，才会继续传递。即：只有收发双方对接上了，数据才会被传递。数据直接从发送方复制到接收方。**非缓冲通道传递数据的方式是同步的。**
下面的代码执行会报错
```go
package main

import (
    "fmt"
)

func main() {
    ch := make(chan int)
    ch <- 1

    v := <-ch
    fmt.Println(v)
}
```
报错如下：
```
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [chan send]:
main.main()
	/Users/didi/Documents/learn/src/chan.go:9 +0x59
exit status 2
```
因为这里创建的是无缓冲通道。

* **缓冲通道**：如果通道已满，对它的所有发送操作都会被阻塞，直到通道中有元素值被接收走。反之，如果通道已空，那么对它的所有接收操作都会被阻塞，直到通道中有新的元素值出现。元素值会先从发送方复制到缓冲通道，之后再由缓冲通道复制给接收方。**缓冲通道传递数据的方式是异步的。**

#### 五、Channel的源码学习
Channel 的主要实现在 `src/runtime/chan.go` 中，go 版本为 `go version go1.14.6 darwin/amd64`这里主要看 `chansend` 如何实现的。
```go
func chansend(c *hchan, ep unsafe.Pointer, block bool, callerpc uintptr) bool {
	if c == nil {
		if !block {
			return false
		}
		gopark(nil, nil, waitReasonChanSendNilChan, traceEvGoStop, 2)
		throw("unreachable")
	}

	if debugChan {
		print("chansend: chan=", c, "\n")
	}

	if raceenabled {
		racereadpc(c.raceaddr(), callerpc, funcPC(chansend))
	}

	// Fast path: check for failed non-blocking operation without acquiring the lock.
	//
	// After observing that the channel is not closed, we observe that the channel is
	// not ready for sending. Each of these observations is a single word-sized read
	// (first c.closed and second c.recvq.first or c.qcount depending on kind of channel).
	// Because a closed channel cannot transition from 'ready for sending' to
	// 'not ready for sending', even if the channel is closed between the two observations,
	// they imply a moment between the two when the channel was both not yet closed
	// and not ready for sending. We behave as if we observed the channel at that moment,
	// and report that the send cannot proceed.
	//
	// It is okay if the reads are reordered here: if we observe that the channel is not
	// ready for sending and then observe that it is not closed, that implies that the
	// channel wasn't closed during the first observation.
	if !block && c.closed == 0 && ((c.dataqsiz == 0 && c.recvq.first == nil) ||
		(c.dataqsiz > 0 && c.qcount == c.dataqsiz)) {
		return false
	}

	var t0 int64
	if blockprofilerate > 0 {
		t0 = cputicks()
	}

	lock(&c.lock)

	if c.closed != 0 {
		unlock(&c.lock)
		panic(plainError("send on closed channel"))
	}

	if sg := c.recvq.dequeue(); sg != nil {
		// Found a waiting receiver. We pass the value we want to send
		// directly to the receiver, bypassing the channel buffer (if any).
		send(c, sg, ep, func() { unlock(&c.lock) }, 3)
		return true
	}

	if c.qcount < c.dataqsiz {
		// Space is available in the channel buffer. Enqueue the element to send.
		qp := chanbuf(c, c.sendx)
		if raceenabled {
			raceacquire(qp)
			racerelease(qp)
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

	if !block {
		unlock(&c.lock)
		return false
	}

	// Block on the channel. Some receiver will complete our operation for us.
	gp := getg()
	mysg := acquireSudog()
	mysg.releasetime = 0
	if t0 != 0 {
		mysg.releasetime = -1
	}
	// No stack splits between assigning elem and enqueuing mysg
	// on gp.waiting where copystack can find it.
	mysg.elem = ep
	mysg.waitlink = nil
	mysg.g = gp
	mysg.isSelect = false
	mysg.c = c
	gp.waiting = mysg
	gp.param = nil
	c.sendq.enqueue(mysg)
	gopark(chanparkcommit, unsafe.Pointer(&c.lock), waitReasonChanSend, traceEvGoBlockSend, 2)
	// Ensure the value being sent is kept alive until the
	// receiver copies it out. The sudog has a pointer to the
	// stack object, but sudogs aren't considered as roots of the
	// stack tracer.
	KeepAlive(ep)

	// someone woke us up.
	if mysg != gp.waiting {
		throw("G waiting list is corrupted")
	}
	gp.waiting = nil
	gp.activeStackChans = false
	if gp.param == nil {
		if c.closed == 0 {
			throw("chansend: spurious wakeup")
		}
		panic(plainError("send on closed channel"))
	}
	gp.param = nil
	if mysg.releasetime > 0 {
		blockevent(mysg.releasetime-t0, 2)
	}
	mysg.c = nil
	releaseSudog(mysg)
	return true
}

```
从代码中可以看到：

* 有 goroutine 阻塞在 channel recv 队列上，此时缓存队列为空，直接将消息发送给 reciever goroutine，只产生一次复制。

* 当 channel 缓存队列有剩余空间时，将数据放到队列里，等待接收，接收后总共产生两次复制。

* 当 channel 缓存队列已满时，将当前 goroutine 加入 send 队列并阻塞。


* * *

所以，开头的面试题就有了答案：
**读：**
读已经关闭的 chan，能一直读到内容，但是读到的内容根据通道内关闭前是否有元素而不同。
如果 chan 关闭前，buffer 内有元素还未读，会正确读到 chan 内的值，且返回的第二个 bool 值为 true；
如果 chan 关闭前，buffer 内有元素已经被读完，chan 内无值，返回 channel 元素的零值，第二个 bool 值为 false。
**写：**
写已经关闭的 chan 会 panic。