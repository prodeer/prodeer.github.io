+++
date = '2022-04-01T09:00:20+08:00'
title = 'Golang的WaitGroup源码分析'
draft = false
categories = ['Golang']
tags = ['Golang', '源代码']
+++

`WaitGroup` 是开发中经常用到的并发控制手段，其源代码在 `src/sync/waitgroup.go` 文件中，定义了 1 个结构体和 4 个方法：

* **`WaitGroup{}`**：结构体。
* **`state()`**：内部方法，在 `Add()`、`Wait()` 中调用。
* **`Add()`**：添加任务数、改变任务数。
* **`Done()`**：完成任务，其实就是 `Add(-1)`。
* **`Wait()`**：阻塞等待所有任务的完成。

以下源代码基于 `Go 1.17.5` 版本，有删减。
```
$ go version
go version go1.17.5 darwin/amd64
```
在学习之前可以先了解一些概念：

* 结构体对齐相关的内容，可参考[之前的笔记](https://www.cnblogs.com/sunshineliulu/p/11056207.html)。
* 信号量函数有两个：
`runtime_Semacquire` 表示增加一个信号量，并挂起当前 `goroutine`。在 `Wait()` 里用到。
`runtime_Semrelease` 表示减少一个信号量，并唤醒 `sema` 上其中一个正在等待的 `goroutine`。在 `Add()` 里用到。
* `unsafe.Pointer` 用于各种指针相互转换；
`uintptr` 是 `golang` 的内置类型，能存储指针的整型，其底层类型是 `int`，可以和 `unsafe.Pointer` 相互转换。


### 一、结构体
#### 1.1 state1 数组的组成
```go
type WaitGroup struct {
    // 表示 `WaitGroup` 是不可复制的，只能用指针传递，保证全局唯一。
    noCopy noCopy
    // state1 = state（*unit64） + sema（*unit32）
    // state = counter + waiter
    state1 [3]uint32
}
```
`state1` 是一个 `uint32` 数组，包含了`counter` 总数、`waiter` 等待数 和 `sema` 信号量，其中：
* **counter**：通过 `Add()` 设置的子 `goroutine` 的计数值。
* **waiter**：通过 `Wait()` 陷入阻塞的 `waiter` 数。
* **sema**：信号量。

#### 1.2 state 和 sema 的位置
实际上，`counter` 和 `waiter` 合在一起，当成一个 64 位的整数来使用，所以 `state1` 数组又可以看成由 `*unit64` 的 `state` 和 `*unit32` 的 `sema` 组成，即：
```
state1 = state + sema，
其中 state = counter + waiter。
```
32 位系统下4字节对齐，64位系统下8字节对齐，下面的内部方法 `state()` 有进行判断。

`state()` 方法将 `state1` 数组中存储的状态取出来，返回值 `statep` 就是计数器的状态，也就是 `counter` 和 `waiter` 的整体，`semap` 是信号量。
```go
func (wg *WaitGroup) state() (statep *uint64, semap *uint32) {
    // 判断是否64位对齐
    if uintptr(unsafe.Pointer(&wg.state1))%8 == 0 {
        return (*uint64)(unsafe.Pointer(&wg.state1)), &wg.state1[2]
    } else {
        return (*uint64)(unsafe.Pointer(&wg.state1[1])), &wg.state1[0]
    }
}
```
在 `state()` 中，根据运行时分配的地址转化成 `uintptr` 后，再 `%8`，判断结果是否等于0，若为 0， 则说明分配的地址是 64 位对齐。

* 如果是 64 位对齐，则数组前两位是 `state`，后一位是 `sema`；
* 如果不是64位对齐，则前面一位是 `sema`（32位） 后面两位是 `state`。

| 对齐方式 | state[0] | state[1] | state[2] |
| --- | --- | --- | --- |
| 64位 | waiter | counter | sema |
| 32位 | sema | waiter | counter |

当我们初始化一个 `waitGroup` 对象时，其 `counter` 值、`waiter` 值、`sema` 值均为 0。

#### 1.3 为什么这么设计 state1 数组

为什么要把 `counter` 和 `waiter` 当成一个整体来设计？这是因为对 `state` 使用了 `atomic.64` 的操作，如：

* `Add()`

```
state := atomic.AddUint64(statep, uint64(delta)<<32)
```

* `Wait()`
```
state := atomic.LoadUint64(statep)
if atomic.CompareAndSwapUint64(statep, state, state+1) {}
```

要保证 `state` 的 64 位的原子性，就要保证数据是**一次读入内存**的，而要保证这种一次性，就要保证 `state` 是 64 位对齐的。

### 二、Add()函数
利用64位的原子加，给 `counter` 加 `delta`（`delta`可能为负），当 `counter` 变零，通过信号量唤醒等待的 `goroutine`。这里将 `Add()` 分成几步来分析：

* **step 1**：获取 `counter`、`waiter`、和 `sema` 对应的指针，并将 `delta` 加到 `counter` 上。

``` go
// 获取statep、semap 的指针，也就是counter、waiter和sema
statep, semap := wg.state() 
// 把delta左移32位累加到state，也就是把等待的couter利用原子加，加上delta
state := atomic.AddUint64(statep, uint64(delta)<<32)
v := int32(state >> 32) // 低32位是couter，也就是增加的，注意，这里转换成了int32类型
w := uint32(state)      // 高32位是waiter
```

* **step 2**：`counter` 不允许为负数，否则报 `panic`。
``` go
if v < 0 {
    panic("sync: negative WaitGroup counter")
}
```
`counter` 是活跃的 `goroutine` 数量，肯定大于 0，如果它为负数，有两种情况：

第一种是 `Add()` 的时候，`delta` 直接就是负数，进行原子加操作后，`counter` 就小于0，我们一般不这么写；
第二种是执行 `Done()`，也就是 `Add(-1)` 的时候，前一个 `goroutine` 减到了 0，还没执行完，被挂起了，又来了一个 `Done()`，逻辑就出错了。 

* **step 3**：`Add` 和 `Wait` 不能同时调用。

```go
if w != 0 && delta > 0 && v == int32(delta) {
    panic("sync: WaitGroup misuse: Add called concurrently with Wait")
}
```
`waiter` 是等待的 `goroutine` 数量，只有加 1 和置零两种操作，所以肯定大于等于 0，第一次 `Add(n)` 的时候，`counter=n，waiter=0`，`w != 0` 说明已经执行了 `Wait`；

`delta > 0` 说明这是一次加的操作。如果 `v == int32(delta)` 也就是 `v + delta == delta`，推导出 `v=0`，那就可能是第一次` Add()` 或者是执行 `Add(-1) ` 把 `v` 减到了 0，即先 `Wait` 后 `Add` 了，正确的做法是先 `Add` 后 `Wait`。

* **step 4**：`counter > 0`  或 `waiter = 0`，直接返回。

```go
if v > 0 || w == 0 {
    return
}
```
经过累加后，此时，`counter >= 0`。

如果 `counter` 为正，说明不需要释放信号量，直接退出；
如果 `waiter` 为 0，说明没有等待者，也不需要释放信号量，直接退出。

* **step 5**：检查 `WaitGroup` 是否被滥用，即 `Add` 不能与 `Wait` 并发调用。
```go
if *statep != state {
    panic("sync: WaitGroup misuse: Add called concurrently with Wait")    
}
```
执行到这里，`counter=0 && waiter>0`，说明之前的 `Done` 已经完成了，计数器清零，该释放信号，唤醒所有在 `wait` 的 `goroutine` 了。如果这时候 `state` 状态发生变化，则说明当前有人修改过，进行了 `Add` 操作，报 `panic`。

这一步的判断相当于锁，保证 `WaitGroup` 没有被滥用。

* **step 6**：释放所有排队的 `waiter`。
```go
*statep = 0
    for ; w != 0; w-- {
        runtime_Semrelease(semap, false, 0)
}
```
如果执行到这里，一定是负 `delta` 的操作，`counter=0，waiter>0` 说明已经完成任务，没有活跃的 `goroutine` 了，需要释放信号量。将状态全部归 0，并释放所有阻塞的 `waiter`。


### 三、Wait()函数
执行 `Wait()` 函数的主 `goroutine` 会将 `waiter` 值加 1，并阻塞等待该值为 0，才能继续执行后续代码。

``` go
func (wg *WaitGroup) Wait() {
    // 获取statep、semap 的指针，也就是counter、waiter和sema
    statep, semap := wg.state()
    
    for {// 注意这里在死循环中 
        state := atomic.LoadUint64(statep)// 原子操作
        v := int32(state >> 32) // couter
        w := uint32(state)      // waiter
        
        // counter为0，说明所有的goroutine都退出了，不需要等待
        if v == 0 {
            return
        }
        
        // CAS操作增加waiter
        if atomic.CompareAndSwapUint64(statep, state, state+1) {
            // 一旦信号量sema大于0，就挂起当前goroutine
            runtime_Semacquire(semap)
            
            // Add()函数，触发信号量前，会将counter和waiter置为0，所以此时*statep一定为0。如果*statep不为0，说明还未等Waiter执行完Wait()，又执行了Add()或Wait()操作了，WaitGroup发生了复用。
            if *statep != 0 {
                panic("sync: WaitGroup is reused before previous Wait has returned")
            }
            return
        }
    }
}
```

### 四、竞争分析

在 `Add()` 和 `Wait()` 中，对 `state` 数据的操作都存在数据竞争：

|  | 写 | 读 |
| --- | --- | --- |
| Add() | 将 `delta` 加到 `counter` | 最后信号释放的时候，需要读 `waiter` 和 `sema` |
| Wait() | `CAS` 操作，给 `waiter` 加 1，增加 `sema` 信号量 | 读 `counter`，为 0 直接返回 |

解决数据竞争，可以通过加锁来实现，操作前给 `state1` 数组加锁，结束后释放锁，这样肯定没有安全性的问题但是低效。

源码里解决数据竞争，没有使用锁，它分了几种情况来解决：

* `Add` 和 `Add` 并发

多个 `Add` 同时加，只加数，不管是加正数还是加负数，只要加过之后 `counter` **大于0**，就直接 `return`。因为是原子加，总有先后顺序，保证了不会加丢。
```go
if v > 0 || w == 0 {
    return
}
```
如果加负数之后 `counter` **等于0**，这个时候要进行信号的释放操作，不能允许其他的 `Add` 同时改这个数据了。
```go
if w != 0 && delta > 0 && v == int32(delta) {
    panic("sync: WaitGroup misuse: Add called concurrently with Wait")
}
```

* `Add` 和 `Wait` 并发
如果 `Add` 加负数之后 `counter` **等于0**，这个时候要进行信号的释放操作，不允许 `Wait` 去修改这个数据。如果 `Wait` 先读出了 `state` 又改了 `state`，就会 `panic`。
``` go
if *statep != state {
    panic("sync: WaitGroup misuse: Add called concurrently with Wait")
}
``` 

### 五、实例分析
```go
func main() {
    var wg sync.WaitGroup...............①

    wg.Add(2)...........................②
    
    go func() { 
        fmt.Println(1)
        wg.Done().......................③
    }()

	go func() {
        fmt.Println(2)
        wg.Done().......................④
    }()
	
    wg.Wait()...........................⑤
    
	fmt.Println("all work done！")
}
```

执行完 1，2 后，3、4、5 随机执行。

* 假设按【1、2、3、4、5】的顺序执行，`counter` 和 `waiter` 的数值变化如下:
① counter=0，waiter=0 //初始化的默认值为0
② counter=2，waiter=0 //原子加操作，给counter加2
③ counter=1，waiter=0 //完成一个Done，给counter减1，counter从2变成1
④ counter=0，waiter=0 //又完成一个Done，给counter减1，counter变成0，因为满足v>0或w=0，直接return了，不用发信号
⑤ counter=0，waiter=0 //因为v=0，所以直接return，不用CAS操作

* 假设按【1、2、5、3、4】的顺序执行，`counter` 和 `waiter` 的数值变化如下:
① counter=0，waiter=0 //初始化的默认值为0
② counter=2，waiter=0 //原子加操作，给counter加2
⑤ counter=2，waiter=1 //CAS给waiter加1，所以waiter由0变成2
③ counter=1，waiter=1 完成一个Done，给counter减1，counter从2变成1
④ counter=0，waiter=1 又完成一个Done，给counter减1，counter变成0，发信号，通知waiter不再阻塞，main继续执行
