/**
 * Virtual DOM patching algorithm based on Snabbdom by
 * Simon Friis Vindum (@paldepind)
 * Licensed under the MIT License
 * https://github.com/paldepind/snabbdom/blob/master/LICENSE
 *
 * modified by Evan You (@yyx990803)
 *
 * Not type-checking this because this file is perf-critical and the cost
 * of making flow understand it is not worth it.
 */

import VNode, { cloneVNode } from './vnode'
import config from '../config'
import { SSR_ATTR } from 'shared/constants'
import { registerRef } from './modules/ref'
import { traverse } from '../observer/traverse'
import { activeInstance } from '../instance/lifecycle'
import { isTextInputType } from 'web/util/element'

import {
  warn,
  isdef,
  isUndef,
  isTrue,
  makeMap,
  isRegExp,
  isPrimitive
} from '../util/index'

export const emptyNode = new VNode('', {}, [])

//这些vnode钩子会在不同时期给vdom添加class,事件,或者dom属性(和组件vnode钩子不同)
//web平台的钩子函数定义在src/platforms/web/runtime/modules下
const hooks = ['create', 'activate', 'update', 'remove', 'destroy']

//满足以下条件会被认为是相同的节点
//一般只要顶层的vnode是同一个节点就会被认为是相似节点(不会比较children)
function sameVnode (a, b) {
  return (
    a.key === b.key/*key值相同*/ && (
      (
        a.tag === b.tag && //且tag相同
        a.isComment === b.isComment && //且都是/不是注释节点
        isDef(a.data) === isDef(b.data) && //input节点的type相同
        sameInputType(a, b)
      ) || (
        isTrue(a.isAsyncPlaceholder) &&
        a.asyncFactory === b.asyncFactory &&
        isUndef(b.asyncFactory.error)
      )
    )
  )
}

function sameInputType (a, b) {
  if (a.tag !== 'input') return true
  let i
  const typeA = isDef(i = a.data) && isDef(i = i.attrs) && i.type
  const typeB = isDef(i = b.data) && isDef(i = i.attrs) && i.type
  return typeA === typeB || isTextInputType(typeA) && isTextInputType(typeB)
}

//生成旧children的key为key,旧children的下标位置做value的对象
function createKeyToOldIdx (children, beginIdx, endIdx) {
  let i, key
  const map = {}
  for (i = beginIdx; i <= endIdx; ++i) {
    key = children[i].key
    if (isDef(key)) map[key] = i
  }
  return map
}

export function createPatchFunction (backend) {
  let i, j
  const cbs = {}

  //backend会针对不同平台返回不同的值
  const { modules, nodeOps } = backend


  for (i = 0; i < hooks.length; ++i) {
    //cbs保存着所有vnode钩子所保存的回调（35），每个钩子对应的是一个回调数组
    cbs[hooks[i]] = []
    for (j = 0; j < modules.length; ++j) {
      if (isDef(modules[j][hooks[i]])) {
        cbs[hooks[i]].push(modules[j][hooks[i]])
      }
    }
  }

  function emptyNodeAt (elm) {
    return new VNode(nodeOps.tagName(elm).toLowerCase(), {}, [], undefined, elm)
  }

  function createRmCb (childElm, listeners) {
    function remove () {
      if (--remove.listeners === 0) {
        removeNode(childElm)
      }
    }
    remove.listeners = listeners
    return remove
  }

  function removeNode (el) {
    const parent = nodeOps.parentNode(el)
    // element may have already been removed due to v-html / v-text
    if (isDef(parent)) {
      nodeOps.removeChild(parent, el)
    }
  }

  function isUnknownElement (vnode, inVPre) {
    return (
      !inVPre &&
      !vnode.ns &&
      !(
        config.ignoredElements.length &&
        config.ignoredElements.some(ignore => {
          return isRegExp(ignore)
            ? ignore.test(vnode.tag)
            : ignore === vnode.tag
        })
      ) &&
      config.isUnknownElement(vnode.tag)
    )
  }

  let creatingElmInVPre = 0

  //patch最终会调用它将vnode转换为dom节点，并且插入到父DOM节点下面
  //如果是组件vnode创建的dom节点只有前2个有值,第一个参数为组件的vnode,第二个参数为空数组
  function  createElm (
    vnode,
    insertedVnodeQueue,
    parentElm, //父的dom节点，最后一次为真实的body节点，插入到body下面（之前会挂载到父节点）
    refElm,
    nested,
    ownerArray,
    index
  ) {
    if (isDef(vnode.elm) && isDef(ownerArray)) {
      // This vnode was used in a previous render!
      // now it's used as a new node, overwriting its elm would cause
      // potential patch errors down the road when it's used as an insertion
      // reference node. Instead, we clone the node on-demand before creating
      // associated DOM element for it.
      vnode = ownerArray[index] = cloneVNode(vnode)
    }

    vnode.isRootInsert = !nested // for transition enter check
    if (
      /**当是组件vnode的时候会生成/挂载组件DOM节点,随后返回true跳出后面的逻辑**/
    createComponent(vnode, insertedVnodeQueue, parentElm, refElm)
    ) {
      return
    }
    //否则当前vnode不是一个组件vnode
    const data = vnode.data
    const children = vnode.children
    const tag = vnode.tag
    // 元素节点
    if (isDef(tag)) {
      if (process.env.NODE_ENV !== 'production') {
        if (data && data.pre) {
          creatingElmInVPre++
        }
        if (isUnknownElement(vnode, creatingElmInVPre)) {
          warn(
            'Unknown custom element: <' + tag + '> - did you ' +
            'register the component correctly? For recursive components, ' +
            'make sure to provide the "name" option.',
            vnode.context
          )
        }
      }
      // vnode的elm属性一开始为一个占位的dom节点，因为children的dom节点还没有生成
      // 等递归遍历把所有的children的vnode变成真实dom就彻底生成了一个dom树
      vnode.elm = vnode.ns
        ? nodeOps.createElementNS(vnode.ns, tag)
        //createElement是document.createElement的封装
        : nodeOps.createElement(tag, vnode)

      setScope(vnode)

      /* istanbul ignore if */
      if (__WEEX__) {
        // in Weex, the default insertion order is parent-first.
        // List items can be optimized to use children-first insertion
        // with append="tree".
        const appendAsTree = isDef(data) && isTrue(data.appendAsTree)
        if (!appendAsTree) {
          if (isDef(data)) {
            invokeCreateHooks(vnode, insertedVnodeQueue)
          }
          insert(parentElm, vnode.elm, refElm)
        }
        createChildren(vnode, children, insertedVnodeQueue)
        if (appendAsTree) {
          if (isDef(data)) {
            invokeCreateHooks(vnode, insertedVnodeQueue)
          }
          insert(parentElm, vnode.elm, refElm)
        }
      } else {
        /**遍历children递归创建子节点，形成一棵树**/
        createChildren(vnode, children, insertedVnodeQueue)
        if (isDef(data)) {
          // 执行vnode的create钩子(挂载DOM的监听事件)
          invokeCreateHooks(vnode, insertedVnodeQueue)
        }
        //插入节点，因为children可能是树形结构,所以递归调用的时候是从子插入到父，子=>父=>真实dom（body节点）
        //子组件vnode执行的时候没有parentElm,执行这个函数什么都不会发生
        insert(parentElm, vnode.elm, refElm)
      }

      if (process.env.NODE_ENV !== 'production' && data && data.pre) {
        creatingElmInVPre--
      }
      //创建注释和文本节点
    } else if (isTrue(vnode.isComment)) {
      vnode.elm = nodeOps.createComment(vnode.text)
      insert(parentElm, vnode.elm, refElm)
    } else {
      vnode.elm = nodeOps.createTextNode(vnode.text)
      insert(parentElm, vnode.elm, refElm)
    }
  }

  // createElm中如果是一个组件会执行这个函数,通过组件 vnode 创建真实的组件 dom节点
  // 如果是子组件则第一参数为子组件vnode第二个参数为空数组,没有3,4参数
  function createComponent (vnode, insertedVnodeQueue, parentElm, refElm) {
    let i = vnode.data
    if (isDef(i)) {
      //第一次进入vnode.componentInstance为false，还没用实例化(init钩子中实例化子组件)
      //对于keepAlive的组件，下次进入的时候isReactivated为true
      const isReactivated = isDef(vnode.componentInstance) && i.keepAlive
      //如果是组件的vnode会有init方法和hook属性,因为执行了createElement中的installComponentHooks方法(src/core/vdom/create-component.js:200)
      //执行组件的init钩子
      if (isDef(i = i.hook) && isDef(i = i.init)) {
        /** 执行init钩子，创建子组件实例,并且执行$mount生成DOM节点(src/core/vdom/create-component.js:40) **/
        //对于keepAlive缓存过的vnode则会跳过init进入prepatch钩子
        i(vnode, false /* hydrating */)
      }
      /**由于上一步会递归进行，所以此时已是最底层的子组件*/
      // after calling the init hook, if the vnode is a child component
      // it should've created a child instance and mounted it. the child
      // component also has set the placeholder vnode's elm.
      // in that case we can just return the element and be done.
      // 当vnode中有组件的实例(即执行了init钩子,实例化子组件实例并且生成了DOM节点)
      if (isDef(vnode.componentInstance)) { //createElm之后的插入节点逻辑放到这里,并且返回true跳出createElm函数
        // 在递归遍历父子组件的过程中,子组件先插入再是父组件
        // 将当前组件下面的子组件 vnode 放入 insertedVnodeQueue 数组中（用来触发 mounted 钩子）
        initComponent(vnode, insertedVnodeQueue)
        //在上一步已经将dom节点赋值到了vnode.elm属性中
        //将dom节点插入到父组件中
        insert(parentElm, vnode.elm, refElm)
        if (isTrue(isReactivated)) {
          //让keep-alive组件包裹的组件插入到父节点
          reactivateComponent(vnode, insertedVnodeQueue, parentElm, refElm)
        }
        return true
      }
    }
  }

  function initComponent (vnode, insertedVnodeQueue) {
    if (isDef(vnode.data.pendingInsert)) {
      insertedVnodeQueue.push.apply(insertedVnodeQueue, vnode.data.pendingInsert)
      vnode.data.pendingInsert = null
    }
    //将vm实例的$el属性(创建好的dom节点)赋值给占位符vnode(父组件中<hello-world></hello-world>)的elm属性
    vnode.elm = vnode.componentInstance.$el
    if (isPatchable(vnode)) {
      //挂载监听事件,将vnode添加到insertedVnodeQueue中
      invokeCreateHooks(vnode, insertedVnodeQueue)
      setScope(vnode)
    } else {
      // empty component root.
      // skip all element-related modules except for ref (#3455)
      registerRef(vnode)
      // make sure to invoke the insert hook
      insertedVnodeQueue.push(vnode)
    }
  }

  //keep-alive
  function reactivateComponent (vnode, insertedVnodeQueue, parentElm, refElm) {
    let i
    // hack for #4339: a reactivated component with inner transition
    // does not trigger because the inner node's created hooks are not called
    // again. It's not ideal to involve module-specific logic in here but
    // there doesn't seem to be a better way to do it.
    //bug修复
    let innerNode = vnode
    while (innerNode.componentInstance) {
      innerNode = innerNode.componentInstance._vnode
      if (isDef(i = innerNode.data) && isDef(i = i.transition)) {
        for (i = 0; i < cbs.activate.length; ++i) {
          cbs.activate[i](emptyNode, innerNode)
        }
        insertedVnodeQueue.push(innerNode)
        break
      }
    }
    // unlike a newly created component,
    // a reactivated keep-alive component doesn't insert itself
    insert(parentElm, vnode.elm, refElm)
  }

  //调用dom原生的方法插入节点,如果没有parent就会跳过整个函数
  function insert (parent, elm, ref) {
    if (isDef(parent)) {
      if (isDef(ref)) {
        if (nodeOps.parentNode(ref) === parent) {
          nodeOps.insertBefore(parent, elm, ref)
        }
      } else {
        nodeOps.appendChild(parent, elm)
      }
    }
  }

  function createChildren (vnode, children, insertedVnodeQueue) {
    if (Array.isArray(children)) {
      if (process.env.NODE_ENV !== 'production') {
        checkDuplicateKeys(children)
      }
      //遍历children数组的每个元素创建节点(递归遍历)
      for (let i = 0; i < children.length; ++i) {
        createElm(children[i], insertedVnodeQueue, vnode.elm, null, true, children, i)
      }
    } else if (isPrimitive(vnode.text)) { //vnode.text是基础类型就创建一个文本节点添加到vnode.elm(相对于这个子节点的父节点)
      nodeOps.appendChild(vnode.elm, nodeOps.createTextNode(String(vnode.text)))
    }
  }
//找到一个可挂载的节点(渲染vnode)
  function isPatchable (vnode) {
    /**渲染vnode没有componentInstance,占位符vnode才有**/
    while (vnode.componentInstance) {
      //向下找到这个占位符vnode的渲染vnode
      vnode = vnode.componentInstance._vnode
    }
    return isDef(vnode.tag)
  }

  function invokeCreateHooks (vnode, insertedVnodeQueue) {
    for (let i = 0; i < cbs.create.length; ++i) {
      //执行之前给vnode挂载的create钩子(75),最终会执行updateListeners挂载监听事件
      //对于事件的初始化来说create和update功能都相同,但create的第一个参数是一个空的vnode节点,而update是旧的vnode节点
      cbs.create[i](emptyNode, vnode)
    }
    i = vnode.data.hook // Reuse variable
    if (isDef(i)) {
      // 组件vnode钩子好像没有这个？
      if (isDef(i.create)) i.create(emptyNode, vnode)
      /**把组件vnode放入insertedVnodeQueue数组中**/
      //因为是递归的结构,最里层的vnode会作为数组的第一个,然后依次将外层vnode放入insertedVnodeQueue
      //最后维护一个子=>父vnode的数组
      if (isDef(i.insert)) insertedVnodeQueue.push(vnode)
    }
  }

  // set scope id attribute for scoped CSS.
  // this is implemented as a special case to avoid the overhead
  // of going through the normal attribute patching process.
  function setScope (vnode) {
    let i
    if (isDef(i = vnode.fnScopeId)) {
      nodeOps.setStyleScope(vnode.elm, i)
    } else {
      let ancestor = vnode
      while (ancestor) {
        if (isDef(i = ancestor.context) && isDef(i = i.$options._scopeId)) {
          nodeOps.setStyleScope(vnode.elm, i)
        }
        ancestor = ancestor.parent
      }
    }
    // for slot content they should also get the scopeId from the host instance.
    if (isDef(i = activeInstance) &&
      i !== vnode.context &&
      i !== vnode.fnContext &&
      isDef(i = i.$options._scopeId)
    ) {
      nodeOps.setStyleScope(vnode.elm, i)
    }
  }

  function addVnodes (parentElm, refElm, vnodes, startIdx, endIdx, insertedVnodeQueue) {
    for (; startIdx <= endIdx; ++startIdx) {
      createElm(vnodes[startIdx], insertedVnodeQueue, parentElm, refElm, false, vnodes, startIdx)
    }
  }

  function invokeDestroyHook (vnode) {
    let i, j
    const data = vnode.data
    if (isDef(data)) {
      if (isDef(i = data.hook) && isDef(i = i.destroy)) i(vnode)
      for (i = 0; i < cbs.destroy.length; ++i) cbs.destroy[i](vnode)
    }
    if (isDef(i = vnode.children)) {
      for (j = 0; j < vnode.children.length; ++j) {
        invokeDestroyHook(vnode.children[j])
      }
    }
  }

  //删除vnode
  function removeVnodes (parentElm, vnodes, startIdx, endIdx) {
    for (; startIdx <= endIdx; ++startIdx) {
      const ch = vnodes[startIdx]
      if (isDef(ch)) {
        if (isDef(ch.tag)) {
          // 执行vnode的remove钩子
          removeAndInvokeRemoveHook(ch)
          // 执行组件的 destroy 钩子
          invokeDestroyHook(ch)
        } else { // Text node
          removeNode(ch.elm)
        }
      }
    }
  }

  function removeAndInvokeRemoveHook (vnode, rm) {
    if (isDef(rm) || isDef(vnode.data)) {
      let i
      const listeners = cbs.remove.length + 1
      if (isDef(rm)) {
        // we have a recursively passed down rm callback
        // increase the listeners count
        rm.listeners += listeners
      } else {
        // directly removing
        rm = createRmCb(vnode.elm, listeners)
      }
      // recursively invoke hooks on child component root node
      if (isDef(i = vnode.componentInstance) && isDef(i = i._vnode) && isDef(i.data)) {
        removeAndInvokeRemoveHook(i, rm)
      }
      for (i = 0; i < cbs.remove.length; ++i) {
        cbs.remove[i](vnode, rm)
      }
      if (isDef(i = vnode.data.hook) && isDef(i = i.remove)) {
        i(vnode, rm)
      } else {
        rm()
      }
    } else {
      removeNode(vnode.elm)
    }
  }
  /** diff算法 */
  //oldCh是一个数组 newCh也是一个数组
  function updateChildren (parentElm, oldCh, newCh, insertedVnodeQueue, removeOnly) {
    let oldStartIdx = 0
    let newStartIdx = 0
    let oldEndIdx = oldCh.length - 1 //获取旧vnode的最后一个的下标
    let oldStartVnode = oldCh[0] //旧vnode数组中的第一个vnode
    let oldEndVnode = oldCh[oldEndIdx] //旧vnode数组中的最后一个vnode
    let newEndIdx = newCh.length - 1
    let newStartVnode = newCh[0]
    let newEndVnode = newCh[newEndIdx]
    let oldKeyToIdx, idxInOld, vnodeToMove, refElm

    // removeOnly is a special flag used only by <transition-group>
    // to ensure removed elements stay in correct relative positions
    // during leaving transitions
    const canMove = !removeOnly

    if (process.env.NODE_ENV !== 'production') {
      checkDuplicateKeys(newCh)
    }

    while (oldStartIdx <= oldEndIdx && newStartIdx <= newEndIdx) {
      if (isUndef(oldStartVnode)) {
        oldStartVnode = oldCh[++oldStartIdx] // Vnode has been moved left
      } else if (isUndef(oldEndVnode)) {
        oldEndVnode = oldCh[--oldEndIdx]
      } else if (sameVnode(oldStartVnode, newStartVnode)) { // 旧前 = 新前
        //符合某个条件会递归调用patchVnode遍历子节点的更新情况
        patchVnode(oldStartVnode, newStartVnode, insertedVnodeQueue, newCh, newStartIdx)
        oldStartVnode = oldCh[++oldStartIdx]
        newStartVnode = newCh[++newStartIdx]
      } else if (sameVnode(oldEndVnode, newEndVnode)) { // 旧后 = 新后
        patchVnode(oldEndVnode, newEndVnode, insertedVnodeQueue, newCh, newEndIdx)
        oldEndVnode = oldCh[--oldEndIdx]
        newEndVnode = newCh[--newEndIdx]
      } else if (sameVnode(oldStartVnode, newEndVnode)) { // Vnode moved right 旧前 = 新后
        //旧的第一个 = 新的最后一个 则将旧的移动到最后一个
        /**insertBefore： 如果插入的节点已经存在在父节点的子节点列表中，那么它会移动目标节点至相应位置*/
        patchVnode(oldStartVnode, newEndVnode, insertedVnodeQueue, newCh, newEndIdx)
        canMove && nodeOps.insertBefore(parentElm, oldStartVnode.elm, nodeOps.nextSibling(oldEndVnode.elm))
        oldStartVnode = oldCh[++oldStartIdx]
        newEndVnode = newCh[--newEndIdx]
      } else if (sameVnode(oldEndVnode, newStartVnode)) { // Vnode moved left 旧后 = 新前
        //旧的最后一个 = 新的第一个 则将旧的节点插入到第一个
        patchVnode(oldEndVnode, newStartVnode, insertedVnodeQueue, newCh, newStartIdx)
        canMove && nodeOps.insertBefore(parentElm, oldEndVnode.elm, oldStartVnode.elm)
        oldEndVnode = oldCh[--oldEndIdx]
        newStartVnode = newCh[++newStartIdx]
      } else {
        //生成旧children的映射表
        if (isUndef(oldKeyToIdx)) oldKeyToIdx = createKeyToOldIdx(oldCh, oldStartIdx, oldEndIdx)
        //如果newStartVnode的key存在则去这个映射表找newStartVnode的key对应旧children的下标
        idxInOld = isDef(newStartVnode.key)
          ? oldKeyToIdx[newStartVnode.key]
          //新节点中没有定义key则会去一个个比对,找是否在旧children有节点是samenode
          : findIdxInOld(newStartVnode, oldCh, oldStartIdx, oldEndIdx)
        if (isUndef(idxInOld)) {  //根据key没有找到节点则准备创建一个新节点
          createElm(newStartVnode, insertedVnodeQueue, parentElm, oldStartVnode.elm, false, newCh, newStartIdx)
        } else {
          //vnodeToMove为在映射表中找到的,新children的key和旧children的key相同的节点
          vnodeToMove = oldCh[idxInOld]
          if (sameVnode(vnodeToMove, newStartVnode)) {
            patchVnode(vnodeToMove, newStartVnode, insertedVnodeQueue, newCh, newStartIdx)
            oldCh[idxInOld] = undefined
            //将这个相似节点插入到旧children最前面(因为比对的是newStartVnode)
            canMove && nodeOps.insertBefore(parentElm, vnodeToMove.elm, oldStartVnode.elm)
          } else {
            //否则在映射表找到的key对应的旧children和newStartVnode不是相似节点
            //创建一个节点,并且插入到旧children最前面
            // same key but different element. treat as new element
            createElm(newStartVnode, insertedVnodeQueue, parentElm, oldStartVnode.elm, false, newCh, newStartIdx)
          }
        }
        //让newStartVnode的指针指向下个新节点
        newStartVnode = newCh[++newStartIdx]
      }
    }
    /**diff移动节点的时候,会通过 insertBefore 将旧的 DOM 节点移动到新的位置,并不会创建节点(创建节点开销很大)**/
    //旧节点遍历完,而新节点还有
    //则将新节点没有遍历完的节点插入旧节点数组的最后
    if (oldStartIdx > oldEndIdx) {
      refElm = isUndef(newCh[newEndIdx + 1]) ? null : newCh[newEndIdx + 1].elm
      //批量调用createElm将vnode节点变成真实DOM添加到DOM列表中
      addVnodes(parentElm, refElm, newCh, newStartIdx, newEndIdx, insertedVnodeQueue)
    } else if (newStartIdx > newEndIdx) {
      //新节点遍历完,而旧节点还有
      //则删除旧节点多余的真实DOM节点
      removeVnodes(parentElm, oldCh, oldStartIdx, oldEndIdx)
    }
  }

  function checkDuplicateKeys (children) {
    const seenKeys = {}
    for (let i = 0; i < children.length; i++) {
      const vnode = children[i]
      const key = vnode.key
      if (isDef(key)) {
        if (seenKeys[key]) {
          warn(
            `Duplicate keys detected: '${key}'. This may cause an update error.`,
            vnode.context
          )
        } else {
          seenKeys[key] = true
        }
      }
    }
  }

  function findIdxInOld (node, oldCh, start, end) {
    for (let i = start; i < end; i++) {
      const c = oldCh[i]
      if (isDef(c) && sameVnode(node, c)) return i
    }
  }

  //更新新的vnode节点
  function patchVnode (
    oldVnode,
    vnode,
    insertedVnodeQueue,
    ownerArray,
    index,
    removeOnly
  ) {
    //完全相等直接返回
    if (oldVnode === vnode) {
      return
    }

    if (isDef(vnode.elm) && isDef(ownerArray)) {
      // clone reused vnode
      vnode = ownerArray[index] = cloneVNode(vnode)
    }

    const elm = vnode.elm = oldVnode.elm


    if (isTrue(oldVnode.isAsyncPlaceholder)) {
      if (isDef(vnode.asyncFactory.resolved)) {
        hydrate(oldVnode.elm, vnode, insertedVnodeQueue)
      } else {
        vnode.isAsyncPlaceholder = true
      }
      return
    }

    // reuse element for static trees.
    // note we only do this if the vnode is cloned -
    // if the new node is not cloned it means the render functions have been
    // reset by the hot-reload-api and we need to do a proper re-render.
    /**跳过静态节点,优化更新速度**/
    if (isTrue(vnode.isStatic) &&
      isTrue(oldVnode.isStatic) &&
      vnode.key === oldVnode.key &&
      (isTrue(vnode.isCloned) || isTrue(vnode.isOnce))
    ) {
      vnode.componentInstance = oldVnode.componentInstance
      return
    }

    let i
    const data = vnode.data
    // 如果是组件vnode,执行组件vnode的hook中的prepatch钩子
    // 更新子组件 vm 引用到的一些props和事件
    // 其他的属性则会直接复用之前的 vm 实例
    if (isDef(data) && isDef(i = data.hook) && isDef(i = i.prepatch)) {
      /**prepatch钩子内只会更新props(src/core/vdom/create-component.js:67),同时触发子组件的渲染watcher进行重新渲染**/
      i(oldVnode, vnode)
    }
     // 获取旧 vnode 节点的子 vnode 节点
    const oldCh = oldVnode.children
    const ch = vnode.children
    if (isDef(data) && isPatchable(vnode)) {
      // 在更新的时候会调用 vnode 的update钩子（更新属性，样式，指令等预先挂载的函数）
      for (i = 0; i < cbs.update.length; ++i) cbs.update[i](oldVnode, vnode)
      if (isDef(i = data.hook) && isDef(i = i.update)) i(oldVnode, vnode)
    }
    //如果不是一个文本节点
    if (isUndef(vnode.text)) {
      //如果新旧节点的vnode都不是组件vnode
      if (isDef(oldCh) && isDef(ch)) {
        //新旧vnode都有子节点且子节点不同,则执行diff算法(组件没有子节点)
        if (oldCh !== ch) updateChildren(elm, oldCh, ch, insertedVnodeQueue, removeOnly)
      } else if (isDef(ch)) { //只有新节点有子节点,则插入新的vnode的子节点
        if (process.env.NODE_ENV !== 'production') {
          checkDuplicateKeys(ch)
        }
        if (isDef(oldVnode.text)) nodeOps.setTextContent(elm, '')
        //插入vnode
        addVnodes(elm, null, ch, 0, ch.length - 1, insertedVnodeQueue)
      } else if (isDef(oldCh)) { //只有老节点有子节点,新的vnode没有,就删除老节点的子节点
        removeVnodes(elm, oldCh, 0, oldCh.length - 1)
      } else if (isDef(oldVnode.text)) { //老的有文本节点新的没有就删除老的文本节点
        nodeOps.setTextContent(elm, '')
      }
    } else if (oldVnode.text !== vnode.text) {
      //更新文本节点
      nodeOps.setTextContent(elm, vnode.text)
    }
    if (isDef(data)) {
      //每次patch结束后触发postpatch钩子(自定义指令的钩子)
      if (isDef(i = data.hook) && isDef(i = i.postpatch)) i(oldVnode, vnode)
    }
  }
  //执行组件的insert钩子,即触发各个组件mounted钩子(子=>父)
  function invokeInsertHook (vnode, queue, initial) {
    // delay insert hooks for component root nodes, invoke them after the
    // element is really inserted
    // 将 insert 钩子延迟到插入真实 DOM 节点之后触发
    if (isTrue(initial) && isDef(vnode.parent)) {
      vnode.parent.data.pendingInsert = queue
    } else {
      for (let i = 0; i < queue.length; ++i) {
        //执行组件的insert hooks,即触发组件的mounted钩子
        //queue每一个都是一个vnode，insert方法在（src/core/vdom/create-component.js:74）
        //queue的顺序是先子后父，先触发子组件的mounted钩子
        queue[i].data.hook.insert(queue[i])
      }
    }
  }

  let hydrationBailed = false
  // list of modules that can skip create hook during hydration because they
  // are already rendered on the client or has no need for initialization
  // Note: style is excluded because it relies on initial clone for future
  // deep updates (#7063).
  const isRenderedModule = makeMap('attrs,class,staticClass,staticStyle,key')

  // Note: this is a browser-only function so we can assume elms are DOM nodes.
  function hydrate (elm, vnode, insertedVnodeQueue, inVPre) {
    let i
    const { tag, data, children } = vnode
    inVPre = inVPre || (data && data.pre)
    vnode.elm = elm

    if (isTrue(vnode.isComment) && isDef(vnode.asyncFactory)) {
      vnode.isAsyncPlaceholder = true
      return true
    }
    // assert node match
    if (process.env.NODE_ENV !== 'production') {
      if (!assertNodeMatch(elm, vnode, inVPre)) {
        return false
      }
    }
    if (isDef(data)) {
      if (isDef(i = data.hook) && isDef(i = i.init)) i(vnode, true /* hydrating */)
      if (isDef(i = vnode.componentInstance)) {
        // child component. it should have hydrated its own tree.
        initComponent(vnode, insertedVnodeQueue)
        return true
      }
    }
    if (isDef(tag)) {
      if (isDef(children)) {
        // empty element, allow client to pick up and populate children
        if (!elm.hasChildNodes()) {
          createChildren(vnode, children, insertedVnodeQueue)
        } else {
          // v-html and domProps: innerHTML
          if (isDef(i = data) && isDef(i = i.domProps) && isDef(i = i.innerHTML)) {
            if (i !== elm.innerHTML) {
              /* istanbul ignore if */
              if (process.env.NODE_ENV !== 'production' &&
                typeof console !== 'undefined' &&
                !hydrationBailed
              ) {
                hydrationBailed = true
                console.warn('Parent: ', elm)
                console.warn('server innerHTML: ', i)
                console.warn('client innerHTML: ', elm.innerHTML)
              }
              return false
            }
          } else {
            // iterate and compare children lists
            let childrenMatch = true
            let childNode = elm.firstChild
            for (let i = 0; i < children.length; i++) {
              if (!childNode || !hydrate(childNode, children[i], insertedVnodeQueue, inVPre)) {
                childrenMatch = false
                break
              }
              childNode = childNode.nextSibling
            }
            // if childNode is not null, it means the actual childNodes list is
            // longer than the virtual children list.
            if (!childrenMatch || childNode) {
              /* istanbul ignore if */
              if (process.env.NODE_ENV !== 'production' &&
                typeof console !== 'undefined' &&
                !hydrationBailed
              ) {
                hydrationBailed = true
                console.warn('Parent: ', elm)
                console.warn('Mismatching childNodes vs. VNodes: ', elm.childNodes, children)
              }
              return false
            }
          }
        }
      }
      if (isDef(data)) {
        let fullInvoke = false
        for (const key in data) {
          if (!isRenderedModule(key)) {
            fullInvoke = true
            invokeCreateHooks(vnode, insertedVnodeQueue)
            break
          }
        }
        if (!fullInvoke && data['class']) {
          // ensure collecting deps for deep class bindings for future updates
          traverse(data['class'])
        }
      }
    } else if (elm.data !== vnode.text) {
      elm.data = vnode.text
    }
    return true
  }

  function assertNodeMatch (node, vnode, inVPre) {
    if (isDef(vnode.tag)) {
      return vnode.tag.indexOf('vue-component') === 0 || (
        !isUnknownElement(vnode, inVPre) &&
        vnode.tag.toLowerCase() === (node.tagName && node.tagName.toLowerCase())
      )
    } else {
      return node.nodeType === (vnode.isComment ? 8 : 3)
    }
  }
  /**_patch__返回的是这个patch函数**/
  // patch函数不会关心平台,在之前已经有柯里化的函数判断过了
  //只有当组件更新/根实例创建的时候会有oldVnode,组件创建没有oldVnode
  return function patch (oldVnode, vnode, hydrating, removeOnly) {
    if (isUndef(vnode)) {
      //执行vnode的组件钩子destroy,删除节点
      if (isDef(oldVnode)) invokeDestroyHook(oldVnode)
      return
    }

    let isInitialPatch = false
    const insertedVnodeQueue = []

    /**非根实例第一次挂载*/
    if (isUndef(oldVnode)) {
      // empty mount (likely as component), create new root element
      isInitialPatch = true
      // 创建组件节点
      createElm(vnode, insertedVnodeQueue)
    } else {
      const isRealElement = isDef(oldVnode.nodeType)
      // 不是一个真实的dom节点且是一个相似节点,会进行diff算法逐层比对
      // 相似节点:最外层的vnode(不包括children)相同
      /**组件树更新*/
      if (!isRealElement && sameVnode(oldVnode, vnode)) {
        // patch existing root node
        patchVnode(oldVnode, vnode, insertedVnodeQueue, null, null, removeOnly)
      } else {
        //如果 oldVnode 是一个真实的dom节点，即Vue第一次进行挂载，即根实例挂载（id="app"）
        /**根实例第一次挂载*/
        // 貌似找不到什么不是 sameVnode，同时 isRealElement 为 false 的逻辑
        if (isRealElement) {
          // mounting to a real element
          // check if this is server-rendered content and if we can perform
          // a successful hydration.
          // SSR相关，判断结果为false
          if (oldVnode.nodeType === 1 && oldVnode.hasAttribute(SSR_ATTR)) {
            oldVnode.removeAttribute(SSR_ATTR)
            hydrating = true
          }
          //也是false
          if (isTrue(hydrating)) {
            if (hydrate(oldVnode, vnode, insertedVnodeQueue)) {
              invokeInsertHook(vnode, insertedVnodeQueue, true)
              return oldVnode
            } else if (process.env.NODE_ENV !== 'production') {
              warn(
                'The client-side rendered virtual DOM tree is not matching ' +
                'server-rendered content. This is likely caused by incorrect ' +
                'HTML markup, for example nesting block-level elements inside ' +
                '<p>, or missing <tbody>. Bailing hydration and performing ' +
                'full client-side render.'
              )
            }
          }
          // either not server-rendered, or hydration failed.
          // create an empty node and replace it
          // 将真实的dom($el)转换为vnode
          oldVnode = emptyNodeAt(oldVnode)
        }

        /**创建组件节点*/
        // replacing existing element
        const oldElm = oldVnode.elm
        // parent DOM,表示更新后的 DOM 需要插入到这个 DOM 下面
        const parentElm = nodeOps.parentNode(oldElm)

        // create new node
        // 不是一个可以复用的节点,则进行组件的更新
        /**和组件更新不同,替换是生成组件的节点 => 替换占位符 vnode 的elm 属性（子组件渲染出的真实DOM）=> 删除旧节点**/

        //根据新的虚拟dom创建真实的dom节点,并插入到 parent DOM 节点下
        createElm(
          vnode, //新的节点的vnode
          insertedVnodeQueue,
          // extremely rare edge case: do not insert if old element is in a
          // leaving transition. Only happens when combining transition +
          // keep-alive + HOCs. (#4590)
          oldElm._leaveCb ? null : parentElm, //旧节点的父节点,需要知道新的节点挂载到哪个地方
          nodeOps.nextSibling(oldElm)
        )

        // update parent placeholder node element, recursively
        //更新父组件占位符vnode
        if (isDef(vnode.parent)) {
          let ancestor = vnode.parent   //占位符vnode
          const patchable = isPatchable(vnode)
          while (ancestor) {
            for (let i = 0; i < cbs.destroy.length; ++i) {
              cbs.destroy[i](ancestor)
            }
            //将渲染vnode的dom节点更新到父组件占位符vnode的elm属性上
            ancestor.elm = vnode.elm
            if (patchable) {
              for (let i = 0; i < cbs.create.length; ++i) {
                cbs.create[i](emptyNode, ancestor)
              }
              // #6513
              // invoke insert hooks that may have been merged by create hooks.
              // e.g. for directives that uses the "inserted" hook.
              const insert = ancestor.data.hook.insert
              if (insert.merged) {
                // start at index 1 to avoid re-invoking component mounted hook
                for (let i = 1; i < insert.fns.length; i++) {
                  insert.fns[i]()
                }
              }
            } else {
              registerRef(ancestor)
            }
            //parent属性是当前vnode在父组件中的占位符vnode，所以只有渲染vnode才有
            //因为ancestor是一个占位符vnode,占位符vnode是没有parent属性的,所以这里就退出循环
            ancestor = ancestor.parent
          }
        }

        // destroy old node
        // 删除旧节点
        if (isDef(parentElm)) {
          removeVnodes(parentElm, [oldVnode], 0, 0)
        } else if (isDef(oldVnode.tag)) {
          invokeDestroyHook(oldVnode)
        }
      }
    }
    /**触发 mounted 钩子**/
    // 当执行过createElm时,isInitialPatch为true表示已经patch过了,不会执行invokeInsertHook
    // 直到子组件全部挂载完毕,调用栈逐级弹出,到最外层的patch时,因为oldVnode存在(最外层的根实例的挂载点#app)所以isInitialPatch为false
    // 会执行insertedVnodeQueue数组保存的vnode的insert钩子,且数组的元素顺序是子=>父,所以最里层的子组件的insert钩子先执行
    // 即最里层的组件先触发mounted钩子
    invokeInsertHook(vnode, insertedVnodeQueue, isInitialPatch)
    //返回一个真实dom节点
    return vnode.elm
  }
}
