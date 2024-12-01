+++
date = '2021-05-18T00:13:00+08:00'
title = 'Go的Waitgroup和锁'
draft = false
categories = ['Golang']
tags = ['Golang', '源代码']
+++

学 Go 的时候知道 Go 语言支持并发，最简单的方法是通过 go 关键字开启 goroutine 即可。可在工作中，用的是 sync 包的 WaitGroup，然而这样还不够，当多个 goroutine 同时访问一个变量时，还要考虑如何保证这些 goroutine 之间不会相互影响，这就又使用到了 sync 的 Mutex。

#### 一、Goroutinue
先说 goroutine，我们都知道它是 Go 中的轻量级线程。Go 程序从 main 包的 main() 函数开始，在程序启动时，Go 程序就会为 main() 函数创建一个默认的 goroutine。使用 goroutine，使用关键字 go 即可。
```go
package main
import (
    "fmt"
)
func main() {
    // 并发执行程序
    go running()
}
func running() {
    fmt.Println("Goroutine")
}
```
执行代码会发现没有我们预期的“Goroutine”输出，这是因为当前的程序是一个单线程的程序，main 函数只要执行后，就不会再管其他线程在做什么事情，程序就自动退出了。解决办法是加一个 sleep 函数，让 main 函数等待 running 函数执行完毕后再退出。我们假设 running 函数里的代码执行需要 2 秒，因此让 main 函数等待 3 秒再退出。
```go
package main
import (
    "fmt"
    "time"
)
func main() {
    // 并发执行程序
    go running()
    time.Sleep(3 * time.Second)
}
func running() {
    fmt.Println("Goroutine")
}
```
再次执行代码，终端输出了我们想要的“Goroutine”字符串。

#### 二、WaitGroup
上面我们是假设了 running 函数执行需要 2 秒，可如果执行需要 10 秒甚至更长时间，不知道 goroutin 什么时候结束，难道还要 main 函数 sleep 更多的秒数吗？就不能让 running 函数执行完去通知 main 函数，main 函数收到信号自动退出吗？还真可以！可以使用 sync 包的 Waitgroup 判断一组任务是否完成。

WatiGroup 能够一直等到所有的 goroutine 执行完成，并且阻塞主线程的执行，直到所有的 goroutine 执行完成。它有 3 个方法：
* Add()：给计数器添加等待 goroutine 的数量。
* Done()：减少 WaitGroup 计数器的值，应在协程的最后执行。
* Wait()：执行阻塞，直到所有的 WaitGroup 数量变成 0

一个简单的示例如下：
```go
package main 
import ( 
    "fmt” 
    "sync” 
    “time"
) 

func process(i int, wg *sync.WaitGroup) { 
    fmt.Println("started Goroutine ", i) 
    time.Sleep(2 * time.Second) 
    fmt.Printf("Goroutine %d ended\n", i) 
    wg.Done() 
} 

func main() { 
    var wg sync.WaitGroup 
    for i := 0; i < 3; i++ { 
        wg.Add(1) 
        go process(i, &wg) 
    } 
    wg.Wait() 
    fmt.Println("All go routines finished executing”) 
}
//main函数也可以写成如下方式
func main() {
    var wg sync.WaitGroup
    wg.Add(3) //设置计数器，数值即为goroutine的个数
    go process(1, &wg)
    go process(2, &wg)
    go process(3, &wg)
    wg.Wait() //主goroutine阻塞等待计数器变为0
    fmt.Println("All goroutines finished executing")
}
```
命令行输出如下：
```
deer@192 src % go run hello.go //第1次
started Goroutine  3
started Goroutine  1
started Goroutine  2
Goroutine 2 ended
Goroutine 1 ended
Goroutine 3 ended
All goroutines finished executing

deer@192 src % go run hello.go //第2次
started Goroutine  3
started Goroutine  1
started Goroutine  2
Goroutine 1 ended
Goroutine 2 ended
Goroutine 3 ended
All goroutines finished executing

deer@192 src % go run hello.go //第3次
started Goroutine  3
started Goroutine  2
started Goroutine  1
Goroutine 3 ended
Goroutine 1 ended
Goroutine 2 ended
All goroutines finished executing
```
简单的说，上面程序中 wg 内部维护了一个计数器，激活了 3 个 goroutine：
1）每次激活 goroutine 之前，都先调用 Add() 方法增加一个需要等待的 goroutine 计数。
2）每个 goroutine 都运行 process() 函数，这个函数在执行完成时需要调用 Done() 方法来表示 goroutine 的结束。
3）激活 3 个 goroutine 后，main 的 goroutine 会执行到 Wait()，由于每个激活的 goroutine 运行的 process() 都需要睡眠 2 秒，所以 main 的 goroutine 在 Wait() 这里会阻塞一段时间(大约2秒)，
4）当所有 goroutine 都完成后，计数器减为 0，Wait() 将不再阻塞，于是 main 的 goroutine 得以执行后面的 Println()。

这里需要注意：
1）process() 中使用指针类型的 `*sync.WaitGroup` 作为参数，表示这 3 个 goroutine 共享一个 wg，才能知道这 3 个 goroutine 都完成了。如果这里使用值类型的 `sync.WaitGroup` 作为参数，意味着每个 goroutine 都拷贝一份 wg，每个 goroutine 都使用自己的 wg，main goroutine将会永久阻塞而导致产生死锁。
2）Add() 设置的数量必须与实际等待的 goroutine 个数一致，也就是和Done的调用数量必须相等，否则会panic，报错信息如下：
```
fatal error: all goroutines are asleep - deadlock!
```

#### 三、锁
当多个 goroutine 同时操作一个变量时，会存在数据竞争，导致最后的结果与期待的不符，解决办法就是加锁。Go 中的 sync 包 实现了两种锁：Mutex 和 RWMutex，前者为互斥锁，后者为读写锁，基于 Mutex 实现。当我们的场景是写操作为主时，可以使用 Mutex 来加锁、解锁。
```go
var lock sync.Mutex //声明一个互斥锁
 lock.Lock() //加锁
//code...
 lock.Unlock() //解锁
```
互斥锁其实就是每个线程在对资源操作前都尝试先加锁，成功加锁才能操作，操作结束后再解锁。也就是说，使用了互斥锁，同一时刻只能有一个 goroutine 在执行。