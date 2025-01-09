+++
date = '2022-04-22T22:47:20+08:00'
title = 'Golang的定时器之Time.Ticker'
draft = false
categories = ['Golang']
tags = ['Golang']
+++

### 一、引子

面试官问了一道题：每秒钟调用一次proc并保证程序不退出。
```go
package main

func main() {

}

func proc() {
    panic("ok")
}
```
这道题考察的知识点主要有：
1. 定时执行任务
2. 捕获 `panic` 错误

这里主要学习、了解 `Time.Ticker` 的实现，其源代码基于 `Go 1.17.9` 版本，主要在 `src/time/tick.go` 文件中，包含了一个结构体和四个函数。

### 二、Time.Ticker
`Ticker` 是一个周期触发定时的计时器，它会按照一个时间间隔往 `channel` 发送系统当前时间，而 `channel` 的接收者可以以固定的时间间隔从 `channel` 中读取事件。

#### 2.1 结构体
```go
type Ticker struct {
    C <-chan Time // The channel on which the ticks are delivered.
    r runtimeTimer
}

//注：该结构体在src/time/sleep.go中
type runtimeTimer struct {
    pp       uintptr
    when     int64
    period   int64
    f        func(any, uintptr) // NOTE: must not be closure
    arg      any
    seq      uintptr
    nextwhen int64
    status   uint32
}
```
可以看到这个结构体包含了一个只读的通道 `C`，并每隔一段时间向其传递"tick"。

#### 2.2 NewTicker()
`NewTicker()` 主要包含两步：

1. 创建一个 `Ticker`，主要包括其中的 `C` 属性和 `r` 属性。`r` 属性是 `runtimeTimer` 类型。

2. 调用 `startTimer` 函数，启动 `Ticker`。

如果 `d <= 0` 会 `panic`。
```go
func NewTicker(d Duration) *Ticker {
    if d <= 0 {
        panic(errors.New("non-positive interval for NewTicker"))
    }
	
    c := make(chan Time, 1)
    t := &Ticker{
        C: c,
        r: runtimeTimer{
            when:   when(d),
            period: int64(d),
            f:      sendTime, // f表示一个函数调用，这里的sendTime表示d时间到达时向Timer.C发送当前的时间
            arg:    c, // arg表示在调用f的时候把参数arg传递给f，c就是用来接受sendTime发送时间的
        },
    }
    startTimer(&t.r)
    return t
}
```
这里主要关注 `f`、 `arg` 和 `startTimer(&t.r)`。

* `f` 表示一个函数调用，这里的 `sendTime` 表示 `d` 时间到达时，向 `Timer.C` 发送当前的时间；

* `arg` 表示在调用 `f` 的时候把参数 `arg` 传递给 `f`，`c` 就是用来接受 `sendTime` 发送时间的。

其中 `f` 对应的函数为：
```go
func sendTime(c any, seq uintptr) {
    select {
    case c.(chan Time) <- Now():
    default:
    }
}
```

`ticker` 对象构造好后，就调用了 `startTimer` 函数，`startTimer` 具体的函数定义在 runtime/time.go 中
```go
// startTimer adds t to the timer heap.
//go:linkname startTimer time.startTimer
func startTimer(t *timer) {
    if raceenabled {
        racerelease(unsafe.Pointer(t))
    }
    addtimer(t)
}
```
里面实际调用了 `addtimer()` 函数。
```go
func addtimer(t *timer) {
    // when must be positive. A negative value will cause runtimer to
    // overflow during its delta calculation and never expire other runtime
    // timers. Zero will cause checkTimers to fail to notice the timer.
    if t.when <= 0 {
        throw("timer when must be positive")
    }
    if t.period < 0 {
        throw("timer period must be non-negative")
    }
    if t.status != timerNoStatus {
        throw("addtimer called with initialized timer")
    }
    t.status = timerWaiting

    when := t.when

    // Disable preemption while using pp to avoid changing another P's heap.
    // 禁用p被抢占去避免去改变其他p的堆栈
    mp := acquirem()

    pp := getg().m.p.ptr() // 获取当前p
    lock(&pp.timersLock)
    cleantimers(pp)       // 清除timers
    doaddtimer(pp, t)     // 添加timer到当前p的堆上，在锁中执行
    unlock(&pp.timersLock) 

    wakeNetPoller(when)   // 添加到Netpoller

    releasem(mp)
}
```
`addtimer` 就是将 `timer` 加到当前执行 `p` 的 `timers` 数组里面去，调用 `wakeNetPoller` 方法唤醒网络轮询器中休眠的线程，检查计时器被唤醒的时间（when）是否在当前轮询预期运行的时间内，若是，就唤醒。

#### 2.3 stop()
`Stop` 关闭一个 `Ticker`，但不会关闭通道 `t.C`，防止读取通道发生错误。
```go
func (t *Ticker) Stop() {
    stopTimer(&t.r)
}
```
`stopTimer` 具体的函数定义也是在 runtime/time.go 中，实际调用了 `deltimer()` 函数。
```go
func stopTimer(t *timer) bool {
    return deltimer(t)
}

func deltimer(t *timer) bool {
    for {
        switch s := atomic.Load(&t.status); s {
        case timerWaiting, timerModifiedLater:
            // Prevent preemption while the timer is in timerModifying.
            // This could lead to a self-deadlock. See #38070.
            mp := acquirem()
            if atomic.Cas(&t.status, s, timerModifying) {
                // Must fetch t.pp before changing status,
                // as cleantimers in another goroutine
                // can clear t.pp of a timerDeleted timer.
                tpp := t.pp.ptr()
                if !atomic.Cas(&t.status, timerModifying, timerDeleted) {
                    badTimer()
                }
                releasem(mp)
                atomic.Xadd(&tpp.deletedTimers, 1)
                // Timer was not yet run.
                return true
            } else {
                releasem(mp)
            }
        case timerModifiedEarlier:
            // Prevent preemption while the timer is in timerModifying.
            // This could lead to a self-deadlock. See #38070.
            mp := acquirem()
            if atomic.Cas(&t.status, s, timerModifying) {
                // Must fetch t.pp before setting status
                // to timerDeleted.
                tpp := t.pp.ptr()
                if !atomic.Cas(&t.status, timerModifying, timerDeleted) {
                    badTimer()
                }
                releasem(mp)
                atomic.Xadd(&tpp.deletedTimers, 1)
                // Timer was not yet run.
                return true
            } else {
                releasem(mp)
            }
        case timerDeleted, timerRemoving, timerRemoved:
            // Timer was already run.
            return false
        case timerRunning, timerMoving:
            // The timer is being run or moved, by a different P.
            // Wait for it to complete.
            osyield()
        case timerNoStatus:
            // Removing timer that was never added or
            // has already been run. Also see issue 21874.
            return false
        case timerModifying:
            // Simultaneous calls to deltimer and modtimer.
            // Wait for the other call to complete.
            osyield()
        default:
            badTimer()
        }
    }
}
```
简单来说就是修改 `timer` 的状态，先修改为“已修改”，再修改为“删除”。

#### 2.4 Reset()
`Reset()` 调用 `modTimer()` 修改时间，接下来的激活将在新 `d` 后。
```
func (t *Ticker) Reset(d Duration) {
    if d <= 0 {
        panic("non-positive interval for Ticker.Reset")
    }
    if t.r.f == nil {
        panic("time: Reset called on uninitialized Ticker")
    }
    modTimer(&t.r, when(d), int64(d), t.r.f, t.r.arg, t.r.seq)
}
```

#### 2.5 Tick()
返回 `ticker` 的 `channel`。
```go
func Tick(d Duration) <-chan Time {
    if d <= 0 {
        return nil
    }
    return NewTicker(d).C
}
```

### 三、小结

1. Go 的定时器实质是单向通道，`time.Ticker` 结构体类型中有一个`time.Time` 类型的单向 `channel`。
2. `ticker` 创建完之后，不是马上就有一个 `tick`，第一个 `tick` 在 x 秒之后。
3. `time.NewTicker` 定时触发执行任务，当下一次执行到来而当前任务还没有执行结束时，会等待当前任务执行完毕后再执行下一次任务。
4. `Stop` 不会停止定时器。这是因为 `Stop` 会停止 `Timer`，停止后，`Timer` 不会再被发送，但是 `Stop` 不会关闭通道，防止读取通道发生错误。如果想停止定时器，只能让 go 程序自动结束。

回到开头的问题，怎么实现每秒执行一次proc并保证程序不退出，可以使用 `time.Ticker` 实现定时器的功能，使用 `recover()` 函数捕获 `panic` 错误。参考答案如下：
```go
package main

import (
    "fmt"
    "time"
)

func main() {
    go func() {
        t := time.NewTicker(time.Second * 1)
        for {
            select {
            case <-t.C:
                go func() {
                    defer func() {
                        if err := recover(); err != nil {
                            fmt.Println("recover", err)
                        }
                    }()
                }()

                proc()
            }
        }
    }()

    select {}
}

func proc() {
    panic("ok")
}

```
---
参考链接：[深入解析go Timer 和Ticker实现原理](https://blog.csdn.net/weixin_44505163/article/details/121191165) 
