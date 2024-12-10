+++
date = '2023-03-29T23:30:00+08:00'
title = 'Go的结构体标签与反射'
draft = false
categories = ['Golang']
tags = ['反射', '源代码']
+++

## 一、结构体标签

结构体标签是附加在结构体字段上的小块元数据字符串，格式为 `key:"value"`，其中 `key` 是标签名，`value` 是标签的值。一个字段可以有多个标签，标签之间用空格分隔。

```go
type User struct {
    Name string `json:"name" xml:"user_name"`
    Age  int    `json:"age" xml:"user_age"`
}
```

在这个例子中，`Name` 和 `Age` 字段都有两个标签，分别用于JSON和XML的序列化

## 二、结构体标签的读取

要读取结构体字段的标签，可以使用`reflect`包中的`Field`方法获取结构体的字段，然后使用`Tag`方法获取标签字符串。

```go
import (
    "fmt"
    "reflect"
)

type MyStruct struct {
    Name string `这是个名字标签`                         // 不推荐
    id   int    `desc:"这是id标签" sort:"这个字段可以用来排序"` // 推荐使用key value的方式定义标签
}

func main() {
    // 通过反射获取标签
    m := MyStruct{"小明", 1}
    r := reflect.TypeOf(m)
    for i := 0; i < r.NumField(); i++ {
        field := r.Field(i)
        tag := field.Tag
        fmt.Println(field.Name, "的标签->", tag)
    }
}
```

输出的结果是：

```go
Name 的标签->  
id 的标签-> desc:"这是id标签" sort:"这个字段可以用来排序"
```

* `Name`字段的标签是`"这是个名字标签"`，但这个标签没有遵循`key:"value"`正确的格式，因此它不会被`reflect`包识别为有效的结构体标签。
* `id`字段的标签是`"desc:\"这是id标签\" sort:\"这个字段可以用来排序\""`，这是一个有效的结构体标签，包含了两个键值对：`desc`和`sort`。

## 三、结构体与反射

从上面的例子可以看到，Go语言的反射库`reflect`能够访问结构体标签信息。`reflect`包封装了反射相关的方法来获取任意对象的`Value`和`Type`。

* `reflect.TypeOf()`：返回变量的类型，类型信息由 `reflect.Type` 接口表示。
* `reflect.ValueOf()`：返回变量的值，值信息由 `reflect.Value` 表示。

## 四、reflect源码分析

`reflect`包的源码可以在`src/reflect`下面查看，例如 `type.go` 和 `value.go`，以下源代码基于 go1.23.3 版本，有删减。

### 4.1 reflect.Type

先看`reflect.TypeOf()`的实现，源代码在`type.go`：

```go
func TypeOf(i any) Type {
    return toType(abi.TypeOf(i))
}

func toType(t *abi.Type) Type {
    if t == nil {
       return nil
    }
    return toRType(t)
}

func toRType(t *abi.Type) *rtype {
    return (*rtype)(unsafe.Pointer(t))
}
```

`TypeOf()`函数对外提供了一个接口，用于获取任意类型`i`的类型信息。内部使用`abi.TypeOf()`函数来获取ABI层面的类型信息，然后通过`reflect.toType()`和`reflect.toRType()`函数将ABI层面的类型信息转换为`reflect`包内部使用的`*rtype`类型，`reflect.Type` 相关的操作都是基于 `*rtype`实现的。

在 golang 的反射中， 有两个可以表示**类型**的关键字，`Kind` 和 `Type` 。go 中的基本类型总共 **26** 种，在反射中定义的枚举如下：

```go
type Kind uint

const (
    Invalid Kind = iota
    Bool
    Int
    Int8
    Int16
    Int32
    Int64
    Uint
    Uint8
    Uint16
    Uint32
    Uint64
    Uintptr
    Float32
    Float64
    Complex64
    Complex128
    Array
    Chan
    Func
    Interface
    Map
    Pointer
    Slice
    String
    Struct
    UnsafePointer
)
```

### 4.2 reflect.Value

再来看`reflect.ValueOf()`的实现，源代码在`value.go`：

```go
// ValueOf returns a new Value initialized to the concrete value
// stored in the interface i. ValueOf(nil) returns the zero Value.
func ValueOf(i any) Value {
    if i == nil {
       return Value{}
    }
    return unpackEface(i)
}

func unpackEface(i any) Value {
    e := (*abi.EmptyInterface)(unsafe.Pointer(&i))
    // NOTE: don't read e.word until we know whether it is really a pointer or not.
    t := e.Type
    if t == nil {
       return Value{}
    }
    f := flag(t.Kind())
    if t.IfaceIndir() {
       f |= flagIndir
    }
    return Value{t, e.Data, f}
}
```

`reflect.ValueOf()`函数主要是通过`unpackEface`函数来从接口值中提取具体的值，并返回对应的`Value`。

`unpackEface`函数处理了从空接口到具体值的转换，包括类型信息和数据指针的提取，以及`Value`对象的构造。

## 五、小结

通过`reflect.Type`和`reflect.Value`，Go提供了反射机制，允许程序在运行时检查和操作类型的信息，包括结构体的标签。解析结构体标签的步骤如下：

1. **获取结构体类型信息（reflect.Type）**：通过`reflect.TypeOf()`函数实现，它接受一个接口类型的参数，并返回该参数的动态类型信息。

```go
type MyStruct struct {
    Field1 string `json:"field1"`
    Field2 int    `json:"field2"`
}

var myStruct MyStruct
t := reflect.TypeOf(myStruct) // 获取MyStruct的类型信息
```

2. **遍历结构体字段**：使用`NumField()`方法获取结构体字段的数量，然后通过`Field(i)`方法遍历每个字段，其中`i`是字段的索引。

```go
for i := 0; i < t.NumField(); i++ {
    field := t.Field(i)
}
```

3. **获取字段标签（reflect.StructField）**：对于每个字段，使用`StructField.Tag`获取字段的标签字符串。`Tag`是一个`reflect.StructTag`类型，它包含了字段的标签信息。

```go
tag := field.Tag // 获取字段的标签
```

4. **解析标签**：使用`StructTag.Get(key)`方法可以获取指定键的标签值。

```go
if tag := field.Tag; tag != "" {
    jsonTag := tag.Get("json") // 获取json标签的值
}
```