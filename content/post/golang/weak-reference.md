+++
date = '2023-01-09T00:13:00+08:00'
title = 'Golang的弱引用'
draft = false
categories = ['Golang']
tags = ['Golang', '垃圾回收']
+++

在学习观察者模式的时候，看到观察者模式的实现方式之一有弱引用，所以专门学习了一下这个知识点。

<!--more-->

### 一、什么是弱引用

弱引用是一种特殊的引用类型，它允许引用一个对象而不增加该对象的引用计数。这意味着，弱引用不会阻止垃圾回收器（GC）回收被引用的对象，即使该对象只被弱引用关联。

说人话就是：弱引用的对象在任何时候都可能被垃圾回收器回收。

### 二、弱引用的应用场景

弱引用在处理缓存、对象池、观察者模式等场景中非常有用。在这些应用场景中，我们通常需要一个数据结构能够动态地增减对象，同时不会让这些对象被垃圾回收机制所回收，弱引用正好能够满足这个需求。

### 三、弱引用在Go中存在吗

答案：存在。

### 四、弱引用在Go语言中具体是如何实现的

1. **`sync.Map`**：`sync.Map`与普通的`map`不同，它不会阻止其键的垃圾回收。这意味着，如果一个键没有其他强引用，它所引用的对象可以被垃圾回收器回收。`sync.Map`提供了`Store`、`Load`和`Delete`等方法来操作键值对，同时允许垃圾回收器回收不再需要的键值对。
2. **`sync.Pool`**：`sync.Pool`提供了一种对象池的机制，它允许对象在不被使用时被回收。`sync.Pool`中的对象是弱引用的，它们可以在内存不足时被垃圾回收器回收，这使得`sync.Pool`成为实现缓存时避免内存泄漏的有用工具。
3. **`reflect.WeaklyTypedPtr`**&#x65B9;法：Go语言在标准库中提供了一种弱引用的实现方式，即使用`reflect`包中的`WeaklyTypedPtr`方法。该方法接受一个`interface{}`类型的输入，并将其转换为弱引用。使用该方法可以创建一个不会增加对象引用计数的指针，同时也不会让该对象被垃圾回收机制所忽略，这使得开发者能够更加灵活地管理内存。
4. **垃圾回收机制**：Go语言的垃圾回收机制也与弱引用有关。垃圾回收器会标记所有可达的对象为活跃状态，而未被标记的对象将被清除。在这个过程中，如果一个对象只被弱引用，那么它可能会被垃圾回收器回收。

### 五、实现一个自定义的弱引用机制

在Go语言中实现一个自定义的弱引用机制，可以通过以下几种方式：

#### 1. 使用`sync.Map`实现

`sync.Map`是Go语言中提供的一种并发安全的map，它允许键被垃圾回收，即使它们仍然被`sync.Map`引用。因此，可以用`sync.Map`来实现弱引用。
```go
import "sync"

var weakMap = sync.Map{}

// 存储弱引用
func StoreWeakRef(key, value any) {
    weakMap.Store(key, value)
}

// 加载弱引用
func LoadWeakRef(key any) (any, bool) {
    return weakMap.Load(key)
}
```
即使`key`被存储在`weakMap`中，如果没有其他强引用指向`key`，`key`仍然可以被垃圾回收器回收。

#### 2. 使用`reflect.WeaklyTypedPtr`方法

Go语言的`reflect`包提供了`WeaklyTypedPtr`方法，可以创建一个弱引用。这种方法允许创建一个不增加对象引用计数的指针，同时也不会阻止垃圾回收机制回收该对象。
```go
import "reflect"

// 创建弱引用
func CreateWeakRef(value interface{}) reflect.Value {
    return reflect.ValueOf(value).Elem()
}
```

#### 3. 结合`sync.Map`和`runtime.GC`
在某些场景下，可以结合使用`sync.Map`和`runtime.GC`来实现弱引用的效果。通过`sync.Map`存储对象，并在适当的时候调用`runtime.GC`来强制垃圾回收，从而释放不再需要的对象。

#### 4. 使用`sync.Pool`实现弱引用
`sync.Pool`也可以实现类似弱引用的效果。通过`sync.Pool`存储对象，当内存不足时，存储在`sync.Pool`中的对象可以被垃圾回收器回收。

```go
import "sync"

var pool = sync.Pool{
    New: func() interface{} {
        return &User{Name: "Bob"}
    },
}

// 从池中获取对象
func GetFromPool() *User {
    return pool.Get().(*User)
}
```
从`pool`中获取的对象可以被视为弱引用，因为它们可能在垃圾回收时被回收。

### 六、题外话

与“弱引用”相对应的就是“强引用”啦！

在Go语言中，强引用是指常规的变量引用，即当你在Go程序中创建一个变量并将其指向一个对象时，这个变量就持有了一个对该对象的强引用。

只要强引用存在，垃圾回收器就不会回收被引用的对象，即使内存不足时也不会。

以下是一些关于Go语言中强引用的用法：

#### 1. **变量赋值**：当你将一个变量赋值为某个对象时，这个变量就持有了该对象的一个强引用。

```go
var myObject *MyType = NewMyType()
```

在这个例子中，`myObject`变量持有了一个指向`MyType`类型对象的强引用。

#### 2. **函数参数和返回值**：函数参数和返回值也是强引用的一种形式。当函数被调用时，参数被传递给函数，函数的返回值被返回给调用者，这些都是强引用。

```go
func myFunction(param *MyType) *MyType {
    // ...
    return param
}
```

在这个例子中，`param`和`return`的都是强引用。

#### 3. **指针和接口**：在Go中，指针和接口类型都可以持有强引用。接口类型的变量在内部持有一个具体的类型值和类型信息，这个值就是一个强引用。

```go
var myInterface interface{} = &myObject
```

在这个例子中，`myInterface`持有了一个指向`myObject`的强引用。

#### 4. **切片、Map和通道**：这些内置的数据结构在内部维护了对它们元素的强引用。

```go
var mySlice []MyType
var myMap map[string]MyType
var myChan chan MyType
```

在这个例子中，`mySlice`、`myMap`和`myChan`都持有它们元素的强引用。

#### 5. **GC Roots**：在Go的垃圾回收模型中，强引用是从GC Roots开始可达的对象，这些对象不会被垃圾回收器回收。
