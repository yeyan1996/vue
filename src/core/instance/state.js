/* @flow */

import config from '../config'
import Watcher from '../observer/watcher'
import Dep, { pushTarget, popTarget } from '../observer/dep'
import { isUpdatingChildComponent } from './lifecycle'

import {
  set,
  del,
  observe,
  defineReactive,
  toggleObserving
} from '../observer/index'

import {
  warn,
  bind,
  noop,
  hasOwn,
  hyphenate,
  isReserved,
  handleError,
  nativeWatch,
  validateProp,
  isPlainObject,
  isServerRendering,
  isReservedAttribute
} from '../util/index'

const sharedPropertyDefinition = {
  enumerable: true,
  configurable: true,
  get: noop,
  set: noop
}

// 将target[key]代理转发到target[sourceKey][key]
export function proxy (target: Object, sourceKey: string, key: string) {
  sharedPropertyDefinition.get = function proxyGetter () {
    return this[sourceKey][key]
  }
  sharedPropertyDefinition.set = function proxySetter (val) {
    this[sourceKey][key] = val
  }
  Object.defineProperty(target, key, sharedPropertyDefinition)
}

export function initState (vm: Component) {
  vm._watchers = []
  const opts = vm.$options
  if (opts.props) initProps(vm, opts.props)
  if (opts.methods) initMethods(vm, opts.methods)
  if (opts.data) {
    initData(vm)
  } else {
    observe(vm._data = {}, true /* asRootData */)
  }
  if (opts.computed) initComputed(vm, opts.computed)
  if (opts.watch && opts.watch !== nativeWatch) {
    initWatch(vm, opts.watch)
  }
}

function initProps (vm: Component, propsOptions: Object) {
  const propsData = vm.$options.propsData || {}
  const props = vm._props = {}
  // cache prop keys so that future props updates can iterate using Array
  // instead of dynamic object key enumeration.
  const keys = vm.$options._propKeys = []
  const isRoot = !vm.$parent
  // root instance props should be converted
  if (!isRoot) {
    toggleObserving(false)
  }
  for (const key in propsOptions) {
    keys.push(key)
    const value = validateProp(key, propsOptions, propsData, vm)
    /* istanbul ignore else */
    if (process.env.NODE_ENV !== 'production') {
      const hyphenatedKey = hyphenate(key)
      if (isReservedAttribute(hyphenatedKey) ||
          config.isReservedAttr(hyphenatedKey)) {
        warn(
          `"${hyphenatedKey}" is a reserved attribute and cannot be used as component prop.`,
          vm
        )
      }
      //将props的key变成响应式
      defineReactive(props, key, value, () => {
        //当子组件尝试修改父组件传入的props时会报警告(违反单向数据流)
        if (!isRoot && !isUpdatingChildComponent) {
          warn(
            `Avoid mutating a prop directly since the value will be ` +
            `overwritten whenever the parent component re-renders. ` +
            `Instead, use a data or computed property based on the prop's ` +
            `value. Prop being mutated: "${key}"`,
            vm
          )
        }
      })
    } else {
      defineReactive(props, key, value)
    }
    // static props are already proxied on the component's prototype
    // during Vue.extend(). We only need to proxy props defined at
    // instantiation here.
    // 代理props(组件的代理在Vue.extend时,并非在这里)
    // 组件代理:src/core/global-api/extend.js:102
    if (!(key in vm)) {
      proxy(vm, `_props`, key)
    }
  }
  toggleObserving(true)
}

function initData (vm: Component) {
  let data = vm.$options.data
  //判断是否为函数(即非根实例,组件实例),若是函数,则执行data函数得到返回的对象
  //此时_data属性才会有数据
  data = vm._data = typeof data === 'function'
    ? getData(data, vm)
    : data || {}
  if (!isPlainObject(data)) {
    data = {}
    process.env.NODE_ENV !== 'production' && warn(
      'data functions should return an object:\n' +
      'https://vuejs.org/v2/guide/components.html#data-Must-Be-a-Function',
      vm
    )
  }
  // proxy data on instance
  const keys = Object.keys(data)
  const props = vm.$options.props
  const methods = vm.$options.methods
  let i = keys.length
  while (i--) {
    const key = keys[i]
    // 定义不能在data中声明的属性再在methods中定义这个属性(data属性不能和methods属性名相同)
    // methods,props,data声明的属性最终都会挂载到vm实例上,不允许名字相同(都是通过this[key]形式访问)
    if (process.env.NODE_ENV !== 'production') {
      if (methods && hasOwn(methods, key)) {
        warn(
          `Method "${key}" has already been defined as a data property.`,
          vm
        )
      }
    }
    // 同上(判断data和props)
    if (props && hasOwn(props, key)) {
      process.env.NODE_ENV !== 'production' && warn(
        `The data property "${key}" is already declared as a prop. ` +
        `Use prop default value instead.`,
        vm
      )
    } else if (!isReserved(key)) {
      //代理属性(即访问this[key]代理到this._data[key])
      proxy(vm, `_data`, key)
    }
  }
  // 观察data(src/core/observer/index.js:110)
  // observe data
  observe(data, true /* asRootData */)
}

export function getData (data: Function, vm: Component): any {
  // #7573 disable dep collection when invoking data getters
  pushTarget()
  try {
    /**这个时候会对data中的所有数据进行求值,并且传入当前的vm实例作为this的值,随后才将返回的对象赋值给vm._data属性**/
    return data.call(vm, vm)
  } catch (e) {
    handleError(e, vm, `data()`)
    return {}
  } finally {
    popTarget()
  }
}

const computedWatcherOptions = { lazy: true }

function initComputed (vm: Component, computed: Object) {
  // $flow-disable-line
  const watchers = vm._computedWatchers = Object.create(null)
  // computed properties are just getters during SSR
  const isSSR = isServerRendering()

  for (const key in computed) {
    const userDef = computed[key]
    const getter = typeof userDef === 'function' ? userDef : userDef.get
    if (process.env.NODE_ENV !== 'production' && getter == null) {
      warn(
        `Getter is missing for computed property "${key}".`,
        vm
      )
    }
    //true
    if (!isSSR) {
      // create internal watcher for the computed property.
      // 给每个computed的属性创建一个computed watcher保存在watchers对象中
      // 此时没有求值,只是初始化computed watcher
      watchers[key] = new Watcher(
        vm,
        getter || noop,
        noop,
        computedWatcherOptions //{lazy:true}
      )
    }

    // component-defined computed properties are already defined on the
    // component prototype. We only need to define computed properties defined
    // at instantiation here.
    // 这里为false因为computed的属性这个时候已经在vm实例的原型上定义了（src/core/global-api/extend.js:57）
    // 对于组件已经提前在生成组件构造器的时候创建好computed/props属性了
    if (!(key in vm)) {
      //定义computed对象key属性的getter函数
      defineComputed(vm, key, userDef)
    } else if (process.env.NODE_ENV !== 'production') {
      if (key in vm.$data) {
        warn(`The computed property "${key}" is already defined in data.`, vm)
      } else if (vm.$options.props && key in vm.$options.props) {
        warn(`The computed property "${key}" is already defined as a prop.`, vm)
      }
    }
  }
}

export function defineComputed (
  target: any,
  key: string,
  userDef: Object | Function
) {
  //true
  const shouldCache = !isServerRendering()
  if (typeof userDef === 'function') {
    //给computed的属性设置getter函数
    sharedPropertyDefinition.get = shouldCache
      ? createComputedGetter(key)
      : createGetterInvoker(userDef)
    sharedPropertyDefinition.set = noop
  } else { // computed属性对象的写法(get/set)
    sharedPropertyDefinition.get = userDef.get
      ? shouldCache && userDef.cache !== false
        ? createComputedGetter(key)
        : createGetterInvoker(userDef.get)
      : noop
    sharedPropertyDefinition.set = userDef.set || noop
  }
  if (process.env.NODE_ENV !== 'production' &&
      sharedPropertyDefinition.set === noop) {
    sharedPropertyDefinition.set = function () {
      warn(
        `Computed property "${key}" was assigned to but it has no setter.`,
        this
      )
    }
  }
  Object.defineProperty(target, key, sharedPropertyDefinition)
}

//当别的watcher的依赖项含有当前计算属性时会触发这个计算属性的getter
function createComputedGetter (key) {
  // 返回当前computed属性的getter函数
  // 只有当某个地方使用到了计算属性才会触发getter(模板收集依赖/其他computed函数里依赖了这个计算属性)
  return function computedGetter () {
    //当尝试访问computed属性会触发getter执行下面的逻辑
    //这里获取了当前属性的watcher实例
    const watcher = this._computedWatchers && this._computedWatchers[key]
    if (watcher) {
      // 当视图依赖的computed属性的依赖项被修改了,会先通知自身内部的computed函数求值,给依赖项的dep属性添加栈顶的computed watcher(自身)
      // 执行到computed watcher的回调时会将dirty置为true
      // 执行到render watcher的回调时(更新视图),会收集模板的依赖,随后再次遇到计算属性触发getter,此时dirty为true,执行evaluate求值

      // 在更新视图时会调用render函数重新收集依赖,对于computed属性的依赖项(发布者)没有更新的话,不会重新求值
      // (只有计算属性的依赖项触发的setter才会去触发computed watcher + render watcher)
      if (watcher.dirty) {
        // 执行计算,将计算属性内部所依赖的属性(发布者dep),收集当前栈顶的watcher(computed watcher)
        // 此时watcher.value有值
        // 随后computed watcher被弹出,dirty置为false
        watcher.evaluate()
      }

      // 这个时候如果dirty = true 则栈顶Dep.target不是computed watcher(因为上一步evaluate已经被弹出了)
      // 此时给计算属性的依赖项(依赖项保存的发布者dep)收集当前栈顶的watcher(如果被模板依赖则收集渲染watcher)
      // 最后计算属性的依赖项(依赖项保存的发布者dep)会保存2个订阅者(computed watcher , render watcher(如果被模板依赖))

      // depend是computed watcher独有的方法,给计算属性的依赖项(响应式变量内部的dep属性)都添加当前栈顶的watcher
      // computed watcher中既可以通知内部的响应式变量(dep)收集依赖,又可以被其他dep收集
      if (Dep.target) {
        watcher.depend()
      }
      //返回执行watcher.get()后watcher实例的value属性
      return watcher.value
    }
  }
}

function createGetterInvoker(fn) {
  return function computedGetter () {
    return fn.call(this, this)
  }
}

function initMethods (vm: Component, methods: Object) {
  const props = vm.$options.props
  for (const key in methods) {
    if (process.env.NODE_ENV !== 'production') {
      if (typeof methods[key] !== 'function') {
        warn(
          `Method "${key}" has type "${typeof methods[key]}" in the component definition. ` +
          `Did you reference the function correctly?`,
          vm
        )
      }
      if (props && hasOwn(props, key)) {
        warn(
          `Method "${key}" has already been defined as a prop.`,
          vm
        )
      }
      if ((key in vm) && isReserved(key)) {
        warn(
          `Method "${key}" conflicts with an existing Vue instance method. ` +
          `Avoid defining component methods that start with _ or $.`
        )
      }
    }
    vm[key] = typeof methods[key] !== 'function' ? noop : bind(methods[key], vm)
  }
}

function initWatch (vm: Component, watch: Object) {
  for (const key in watch) {
    const handler = watch[key]
    if (Array.isArray(handler)) {
      for (let i = 0; i < handler.length; i++) {
        createWatcher(vm, key, handler[i])
      }
    } else {
      createWatcher(vm, key, handler)
    }
  }
}

//规范化watch属性的handler方法
function createWatcher (
  vm: Component,
  expOrFn: string | Function,
  handler: any,
  options?: Object
) {
  if (isPlainObject(handler)) {
    options = handler
    handler = handler.handler
  }
  if (typeof handler === 'string') {
    handler = vm[handler]
  }
  //调用$watch（389）传入监听的属性，handler和配置项
  return vm.$watch(expOrFn, handler, options)
}

export function stateMixin (Vue: Class<Component>) {
  // flow somehow has problems with directly declared definition object
  // when using Object.defineProperty, so we have to procedurally build up
  // the object here.
  const dataDef = {}
  dataDef.get = function () { return this._data }
  const propsDef = {}
  propsDef.get = function () { return this._props }
  if (process.env.NODE_ENV !== 'production') {
    dataDef.set = function () {
      warn(
        'Avoid replacing instance root $data. ' +
        'Use nested data properties instead.',
        this
      )
    }
    propsDef.set = function () {
      warn(`$props is readonly.`, this)
    }
  }
  Object.defineProperty(Vue.prototype, '$data', dataDef)
  Object.defineProperty(Vue.prototype, '$props', propsDef)

  Vue.prototype.$set = set
  Vue.prototype.$delete = del
  Vue.prototype.$watch = function (
    expOrFn: string | Function, //一般是监听的属性（字符串）
    cb: any, //handler
    options?: Object
  ): Function {
    const vm: Component = this
    //再次规范化直到handler是个函数
    if (isPlainObject(cb)) {
      return createWatcher(vm, expOrFn, cb, options)
    }

    options = options || {}
    //表示是一个user watcher
    options.user = true
    /**创建了一个watcher实例**/
    const watcher = new Watcher(vm, expOrFn, cb, options)
    if (options.immediate) {
      try {
        cb.call(vm, watcher.value)
      } catch (error) {
        handleError(error, vm, `callback for immediate watcher "${watcher.expression}"`)
      }
    }
    return function unwatchFn () {
      //销毁watcher
      watcher.teardown()
    }
  }
}
