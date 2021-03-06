/* @flow */

import {
  warn,
  remove,
  isObject,
  parsePath,
  _Set as Set,
  handleError,
  noop
} from '../util/index'

import { traverse } from './traverse'
import { queueWatcher } from './scheduler'
import Dep, { pushTarget, popTarget } from './dep'

import type { SimpleSet } from '../util/index'

let uid = 0

/**
 * A watcher parses an expression, collects dependencies,
 * and fires callback when the expression value changes.
 * This is used for both the $watch() api and directives.
 */
//执行初始化vue实例的时候会实例化一个渲染watcher(src/core/instance/lifecycle.js:217)
export default class Watcher {
  vm: Component;
  expression: string;
  cb: Function;
  id: number;
  deep: boolean;
  user: boolean;
  lazy: boolean;
  sync: boolean;
  dirty: boolean;
  active: boolean;
  deps: Array<Dep>;
  newDeps: Array<Dep>;
  depIds: SimpleSet;
  newDepIds: SimpleSet;
  before: ?Function;
  getter: Function;
  value: any;
//如果是computed属性生成的watcher实例第二个参数是computed属性的值(函数),且options.lazy为true
  constructor (
    vm: Component,
    expOrFn: string | Function, //expression Or Function 作为一个渲染watcher会传入核心updateComponent的方法作为组件更新的函数
    cb: Function,
    options?: ?Object,
    isRenderWatcher?: boolean //是否是渲染watcher
  ) {
    this.vm = vm
    if (isRenderWatcher) {
      //将渲染watcher赋值给_watcher属性
      vm._watcher = this
    }
    vm._watchers.push(this)
    // options
    if (options) {
      this.deep = !!options.deep
      this.user = !!options.user
      this.lazy = !!options.lazy //如果是computed watcher的话lazy为true
      this.sync = !!options.sync
      //定义beforeUpdate钩子
      this.before = options.before
    } else {
      this.deep = this.user = this.lazy = this.sync = false
    }
    this.cb = cb //如果是user watcher它的cb为handler函数
    this.id = ++uid // uid for batching
    this.active = true
    //dirty属性和lazy保持同步
    //computed watcher才有dirty
    // 当dirty为true时computed watcher才会重新计算
    // 当dirty为false会直接使用缓存
    this.dirty = this.lazy // for lazy watchers
    this.deps = []
    this.newDeps = []
    this.depIds = new Set()
    this.newDepIds = new Set()
    this.expression = process.env.NODE_ENV !== 'production'
      ? expOrFn.toString()
      : ''
    // parse expression for getter
    if (typeof expOrFn === 'function') {
      // 将渲染watcher的getter属性等于updateComponent函数（updateComponent：生成dom节点的函数）
      // 亦或是一个computed watcher/user watcher 的回调
      this.getter = expOrFn
    } else {
      // user watcher会走这个逻辑，watch一个字符串的变化，返回一个函数赋值给this.getter
      this.getter = parsePath(expOrFn)
      if (!this.getter) {
        this.getter = noop
        process.env.NODE_ENV !== 'production' && warn(
          `Failed watching path: "${expOrFn}" ` +
          'Watcher only accepts simple dot-delimited paths. ' +
          'For full control, use a function instead.',
          vm
        )
      }
    }
    /**实例化的时候就会对非computed watcher进行一次求值,触发回调**/
    this.value = this.lazy
      //computed属性的value为undefined，即第一次的值永远是undefined不会执行回调求值
      ? undefined
      //渲染watcher执行get方法,它会执行updateComponent渲染出节点
      //如果是非渲染watcher让value等于get方法返回的值
      //user watcher也会执行get方法
      : this.get()
  }

  /**
   * Evaluate the getter, and re-collect dependencies.
   */
  //调用watcher.evaluate或者watcher.run会进行求值
  get () {
    //给Dep.target赋值为当前的watcher实例，Dep.target始终为栈顶的watcher
    pushTarget(this)
    let value
    const vm = this.vm
    try {
      // 渲染watcher会执行updateComponent函数
      // 在执行updateComponent函数时,会执行render方法(src/core/instance/render.js:83),这个时候会触发被劫持后定义的getter函数进行依赖收集

      // computed watcher会执行它的getter返回一个值作为value

      // user watcher会执行parsePath返回的函数（src/core/util/lang.js:34）
      // 会先对当前观测的属性求一次值赋值给value（期间会触发依赖收集，将当前key中的dep实例的subs数组添加Dep.target也就是user watcher）
      value = this.getter.call(vm, vm)
    } catch (e) {
      if (this.user) {
        handleError(e, vm, `getter for watcher "${this.expression}"`)
      } else {
        throw e
      }
    } finally {
      // "touch" every property so they are all tracked as
      // dependencies for deep watching
      if (this.deep) {
        //如果user watcher配置了deep属性
        traverse(value)
      }
      //此时依赖已经收集完毕了
      //弹出栈顶的那个watcher实例,将Dep.target等于栈顶的第二个元素
      popTarget()
      this.cleanupDeps()
    }
    return value
  }

  /**
   * Add a dependency to this directive.
   */
  // 给watcher实例的deps属性添加一个dep
  // 给dep的subs属性添加一个watcher
  addDep (dep: Dep) {
    const id = dep.id
    if (!this.newDepIds.has(id)) {
      //给newDepIds和newDeps属性添加dep的id和自身
      this.newDepIds.add(id)
      this.newDeps.push(dep)
      //防止添加多余的dep
      // （当视图更新时会重新收集依赖，此时不变的部分也会重新收集依赖，为了防止多次收集同一个依赖）
      if (!this.depIds.has(id)) {
        //如果不是重复的 wathcer，则将这个watcher添加到传入的dep参数的subs属性(数组)中
        dep.addSub(this)
      }
    }
  }

  /**
   * Clean up for dependency collection.
   */
  cleanupDeps () {
    let i = this.deps.length
    //第一次i=0不会循环
    //判断每次依赖收集的时候移除残留在旧deps却不在新deps的watcher并且删除(不会收集一个v-if为false的模板中的值,修改不会触发dep的notify方法,提升性能)
    while (i--) {
      const dep = this.deps[i]
      if (!this.newDepIds.has(dep.id)) {
        dep.removeSub(this)
      }
    }
    //交换depIds和newDepIds这2个数组
    let tmp = this.depIds
    this.depIds = this.newDepIds
    this.newDepIds = tmp
    this.newDepIds.clear()
    //再次交换回来
    tmp = this.deps
    this.deps = this.newDeps
    this.newDeps = tmp
    this.newDeps.length = 0
  }

  /**
   * Subscriber interface.
   * Will be called when a dependency changes.
   */
  //当watcher的依赖发生变化的时候会执行update方法
  update () {
    /* istanbul ignore else */
    //computed watcher只做一件事就是把dirty = true,在下个watcher触发计算属性的getter时再执行更新
    /**computed watcher并不会延迟到nextTick执行**/
    if (this.lazy) {
      this.dirty = true
    } else if (this.sync) {  //user watcher如果设置了sync属性也会立即执行,不会延迟到nextTick后
      this.run()
    } else {
      //渲染watcher一般会走到这里，传入当前watcher实例，会在vue自定义的nextTick后异步更新队列
      queueWatcher(this)
    }
  }

  /**
   * Scheduler job interface.
   * Will be called by the scheduler.
   */
  //执行watcher保存的回调函数
  run () {
    if (this.active) {
      //对于渲染watcher它的value为undefined
      //这里由于run函数是由数据setter函数触发的，所以当数据改变后会重新渲染视图（执行get方法等于执行updateComponent）
      const value = this.get()
      if (
        //如果新值和旧值是一样的则什么都不会发生(computed/watch)
        //如果监听的是一个对象，对象的属性改变了，但新值和旧值使用的仍是同一个堆内存中的对象所以也是相等的
        value !== this.value ||
        // Deep watchers and watchers on Object/Arrays should fire even
        // when the value is the same, because the value may
        // have mutated.
        isObject(value) ||
        this.deep
      ) {
        // set new value
        const oldValue = this.value
        this.value = value
        //如果是user watcher会执行cb(handler)
        if (this.user) {
          try {
            //给user watcher传入了新的value和旧的value
            this.cb.call(this.vm, value, oldValue)
          } catch (e) {
            handleError(e, this.vm, `callback for watcher "${this.expression}"`)
          }
        } else {
          this.cb.call(this.vm, value, oldValue)
        }
      }
    }
  }

  /**
   * Evaluate the value of the watcher.
   * This only gets called for lazy watchers.
   */
  //触发计算属性的getter后会执行evaluate方法,即执行computed属性的值(函数)
  evaluate () {
    //this.get会把Dep.target的值变为当前的watcher（如果是计算属性调用的就是computed watcher）
    this.value = this.get() //返回执行get后的值
    //求值后将dirty改为false
    this.dirty = false
  }

  /**
   * Depend on all deps collected by this watcher.
   */
  // 一般只有计算属性的watcher才可以收集依赖(收集当前栈顶的Dep.target)
  depend () {
    let i = this.deps.length
    while (i--) {
      // 给computed watcher内部的保存的发布者(在之前evaluate时保存的dep)收集当前栈顶的watcher
      // 此时栈顶的 watcher 已不是这个 computed watcher（可能是渲染watcher或者其他watcher)
      this.deps[i].depend()
    }
  }

  /**
   * Remove self from all dependencies' subscriber list.
   */
  teardown () {
    if (this.active) {
      // remove self from vm's watcher list
      // this is a somewhat expensive operation so we skip it
      // if the vm is being destroyed.
      if (!this.vm._isBeingDestroyed) {
        remove(this.vm._watchers, this)
      }
      let i = this.deps.length
      while (i--) {
        this.deps[i].removeSub(this)
      }
      this.active = false
    }
  }
}
