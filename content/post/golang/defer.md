+++
date = '2023-02-20T13:12:00+08:00'
title = 'Golang的Defer的用法'
draft = false
categories = ['Golang']
tags = ['Golang']
+++

在Go语言中，`defer`定义为关键字， 在开发过程中使用非常高频，本文通过常见案例来学习`defer`的执行机制。
<!--more-->

### 1. defer 的执行顺序是什么？
**示例代码**：
```go
func main() {
    defer fmt.Println(1) // 第1个声明 → 最后执行
    defer fmt.Println(2) // 第2个声明 → 最后执行
    defer fmt.Println(3) // 第3个声明 → 最后执行
}
```
**输出**：
```
3
2
1
```
**解析**：  
`defer`通过栈结构实现，遵循后进先出（LIFO）的顺序执行。最后一个`defer`最先执行，第一个`defer`最后执行。


### 2. defer 的参数计算时机
**示例代码**：
```go
func test() int {
    i := 0
    defer fmt.Println("defer:", i) // 参数 i 的值在 defer 声明时确定
    i++
    return i
}
```
**输出**：
```
defer: 0
```
**解析**：  
`defer`的参数在声明时**立即求值**，而非等到函数退出时才计算。此时 `i` 的值是 `0`，后续的 `i++` 不影响已声明的 `defer`。

### 3. defer 与闭包结合时的变量捕获
**示例代码**：
```go
func test() {
    i := 0
    defer func() { fmt.Println(i) }() // 闭包捕获当前变量 i 的引用
    i++
}
```
**输出**：
```
1
```
**解析**：  
闭包通过引用捕获变量，执行时获取的是变量的最终值。`i` 在 `defer` 后自增到 `1`，因此输出 `1`。

### 4. defer 如何影响返回值？
**示例1：命名返回值**：
```go
func test() (result int) {
    defer func() { 
        result++ 
    }()
    return 5 // 将 result 设为 5 → 执行 defer，result++ → 最终返回 6
}
```
**返回结果**：`6`

**示例2：匿名返回值**：
```go
func test() int {
    i := 0
    defer func() { 
        i++ 
    }()
    return i // 返回值在 return 时确定为 0，后续 i++ 不影响返回值
}
```
**返回结果**：`0`

**解析**：  
- 若返回值**命名**，`defer` 可以修改它（因为直接操作返回值变量）。
- 若返回值**匿名**，`defer` 修改的是局部变量，不影响已确定的返回值。

### 5. defer 在循环中的陷阱
**示例1：直接使用循环变量**：
```go
func test() {
    for i := 0; i < 3; i++ {
        defer fmt.Println(i) // 参数 i 在每次循环中立即求值
    }
}
```
**输出**：
```
2
1
0
```
**示例2：闭包引用循环变量**：
```go
func test() {
    for i := 0; i < 3; i++ {
        defer func() { 
            fmt.Println(i) 
        }() // 闭包捕获的 i 最终是 3（循环结束时的值）
    }
}
```
**输出**：
```
3
3
3
```
**解析**：  
- 直接传递 `i` 作为参数时，每次循环的 `i` 会被立即求值并保留。
- 闭包引用变量时，所有 `defer` 共享同一个变量 `i`，最终值为循环结束后的 `3`。

**修复方法**：  
通过创建局部变量或参数传递当前值：
```go
for i := 0; i < 3; i++ {
    current := i // 创建局部变量
    defer func() { 
        fmt.Println(current) 
    }()
}
// 或
for i := 0; i < 3; i++ {
    defer func(n int) { 
        fmt.Println(n) 
    }(i) // 参数传递当前值
}
```

### 6. defer 与 panic/recover
**示例代码**：
```go
func test() {
    defer func() {
        if r := recover(); r != nil {
            fmt.Println("Recovered:", r)
        }
    }()
    panic("something went wrong")
}
```
**输出**：
```
Recovered: something went wrong
```
**解析**：  
`defer` 在函数退出前执行，虽然发生了 `panic`，但可以通过 `recover()` 在 `defer` 中捕获异常，防止程序崩溃。

### 7. defer 的执行时机
**示例代码**：
```go
func test() {
    defer fmt.Println("defer")
    fmt.Println("normal")
}
```
**输出**：
```
normal
defer
```
**解析**：  
`defer` 在函数返回前执行，**先执行普通语句，再逆序执行所有defer语句**。

### 总结
- **执行顺序**：后进先出（LIFO）。
- **参数求值**：声明时立即求值。
- **闭包陷阱**：注意变量捕获的引用与值传递。
- **返回值**：命名返回值可被修改，匿名返回值不受影响。
- **循环中的 defer**：避免闭包直接引用循环变量。
- **panic 处理**：`defer` + `recover()` 是 Go 中异常恢复的标准做法。