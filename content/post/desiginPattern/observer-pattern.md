+++
date = '2023-01-08T22:52:01+08:00'
draft = false
title = 'Golang实现观察者模式（Observer Pattern）'
categories = ['设计模式']
+++

观察者模式是一种行为型设计模式，它定义了对象间的一种一对多的依赖关系，使得每当一个对象状态发生改变时，其相关依赖对象都会得到通知并自动更新。这种模式也被称为发布-订阅模式、模型-视图模式、源-监听器模式。

<!--more-->

观察者模式的主要目的是解决一个对象状态改变时，如何自动通知其他依赖对象的问题，同时保持对象间的低耦合和高协作性。

在观察者模式中，包含以下几个关键角色：

1. **主题（Subject）**：也称为被观察者，是状态变化的核心对象，负责管理所有的观察者并通知它们。
2. **具体主题（ConcreteSubject）**：具体主题是主题类的子类，它通常包含有经常发生改变的数据，当它的状态发生改变时它向各个观察者发出通知。
3. **观察者（Observer）**：依赖于主题对象的变化，并作出响应。
4. **具体观察者（ConcreteObserver）**：在具体观察者中维护一个指向具体目标对象的引用，它存储具体观察者的相关状态，这些状态需要和具体目标的状态保持一致；它实现了在抽象观察者Observer中定义的update()方法。

### 一、使用场景

1. **车辆追踪系统**：车辆的位置和状态需要实时监测，并及时通知相关的监控中心或用户。
2. **股票市场监控系统**：股票价格变化可以作为主题，而投资者或交易员可以作为观察者。
3. **GUI开发**：按钮、复选框、滚动条等GUI组件可以作为主题，而窗口、文本框等可以作为观察者。

### 二、优点

1. **降低耦合度**：观察者模式通过定义对象之间的一对多依赖关系，使得主题对象和观察者对象之间解耦，提高了系统的灵活性和可维护性。
2. **动态响应**：在并发编程中，系统的状态可能随时发生变化，观察者模式允许观察者对象根据主题对象状态的变化动态调整自己的行为，非常适合事件驱动的系统。
3. **易于扩展**：在并发系统中，新的观察者可以很容易地添加到系统中，而不需要修改现有的代码，提高了系统的可扩展性。
4. **异步通信**：观察者模式支持异步通信，允许系统在不阻塞的情况下进行通信。
5. **广播通信支持**：观察者模式支持广播通信，可以实现多对多的交互，适用于需要通知多个对象的状态变化的场景。

所以观察者模式很适合在并发编程中使用，尤其是在需要处理多个对象之间通信和状态更新的场景中。

### 三、缺点

* **性能问题**：如果一个被观察者对象有很多的直接和间接的观察者的话，将所有的观察者都通知到会花费很多时间。
* **循环依赖**：如果观察者和观察目标间有循环依赖，可能导致系统崩溃。

### 四、实现方式

1. **接口实现**：定义一个观察者接口，所有观察者都需要实现这个接口，主题（Subject）维护一个观察者列表，并在状态变化时遍历这个列表，调用每个观察者的更新方法。
2. **使用Channel和Goroutine**：在Go语言中，可以利用channel和goroutine来实现观察者模式，这种方式适用于并发场景，可以提高效率。
3. **组合方法**：在某些实现中，观察者模式可以与其他设计模式如组合模式结合使用，以实现更复杂的功能。
4. **弱引用**：使用弱引用来持有观察者的引用，允许垃圾回收器在内存不足时回收这些对象，即使存在对它们的弱引用。

### 五、Golang实现

在 Golang 中，可以通过使用`Channel`和`Goroutine`来实现观察者模式。

1. **定义观察者接口**：创建一个`Observer`接口，其中包含一个`Update`方法，用于接收更新。
2. **定义主题接口**：创建一个`Subject`接口，其中包含`Attach`、`Detach`和`Notify`方法，用于管理观察者并分发通知。
3. **实现具体主题**：创建一个具体的主题`ConcreteSubject`结构体，维护一个观察者列表，用于接收更新。
4. **实现具体观察者**：创建具体的观察者`ConcreteObserver`结构体，用于接收来自主题的更新。
5. **使用Goroutine处理更新**：在具体观察者中，使用`Goroutine`来异步处理更新，以避免阻塞。

```go
package main

import (
        "fmt"
        "sync"
)

// Observer 接口定义了观察者需要实现的 Update 方法
type Observer interface {
        Update(message string)
}

// Subject 接口定义了主题需要实现的方法
type Subject interface {
        Attach(observer Observer)
        Detach(observer Observer)
        Notify(message string)
}

// ConcreteSubject 具体主题的实现
type ConcreteSubject struct {
        observers []Observer
        mu        sync.Mutex // 用于并发安全
}

func (s *ConcreteSubject) Attach(observer Observer) {
        s.mu.Lock()
        defer s.mu.Unlock()
        s.observers = append(s.observers, observer)
}

func (s *ConcreteSubject) Detach(observer Observer) {
        s.mu.Lock()
        defer s.mu.Unlock()
        for i, o := range s.observers {
                if o == observer {
                        s.observers = append(s.observers[:i], s.observers[i+1:]...)
                        break
                }
        }
}

func (s *ConcreteSubject) Notify(message string) {
        s.mu.Lock()
        defer s.mu.Unlock()
        for _, observer := range s.observers {
                // 使用Goroutine异步通知
                go observer.Update(message)
        }
}

// ConcreteObserver 具体观察者的实现
type ConcreteObserver struct {
        id int
}

func (o *ConcreteObserver) Update(message string) {
        fmt.Printf("Observer %d received message: %s\n", o.id, message)
}

func main() {
        subject := &ConcreteSubject{}

        observer1 := &ConcreteObserver{id: 1}
        observer2 := &ConcreteObserver{id: 2}

        subject.Attach(observer1)
        subject.Attach(observer2)

        // 使用channel来传递消息
        messages := make(chan string)

        // 启动一个goroutine来模拟消息发送
        go func() {
                messages <- "Hello, Observers!"
                close(messages)
        }()

        // 从channel接收消息并通知观察者
        go func() {
                for message := range messages {
                        subject.Notify(message)
                }
        }()

        // 等待所有消息处理完成
        // 这里仅为示例，实际应用中可能需要更复杂的同步机制
        select {}
}
```

### 5.1 主要逻辑

#### ConcreteSubject 方法

* **Attach(observer Observer)**：添加一个观察者到观察者列表。
  使用`sync.Mutex`来保证在并发环境下对观察者列表的操作是安全的。
* **Detach(observer Observer)**：从观察者列表中移除一个观察者。
  同样使用`sync.Mutex`来保证操作的线程安全性。
* **Notify(message string)**：通知所有观察者新的消息。
  遍历观察者列表，并为每个观察者启动一个新的`goroutine`来异步调用其`Update`方法。这样，主题不会等待每个观察者的`Update`方法执行完成，从而实现异步通知。

#### ConcreteObserver 方法
* **Update(message string)**：接收从主题发来的消息，并打印出来。

### 5.2 异步处理

这里使用了`goroutine`和`channel`来实现异步处理。`channel`用于在`goroutine`之间同步消息，而`goroutine`允许`Notify`方法非阻塞地执行，即使观察者的`Update`方法可能需要一些时间来处理消息。
