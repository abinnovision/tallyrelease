# Changelog

## [0.5.0](https://github.com/abinnovision/tallyrelease/compare/cli-v0.4.1...cli-v0.5.0) (2026-10-26)


### Features

* generate docs from the config schema and typed error code registries ([#82](https://github.com/abinnovision/tallyrelease/issues/82)) ([9ee6b60](https://github.com/abinnovision/tallyrelease/commit/9ee6b6048cefaf74c9bd63403ab2db3badbc8b11))


### Bug Fixes

* **cli:** name the file in malformed plugin manifest errors ([#78](https://github.com/abinnovision/tallyrelease/issues/78)) ([81f23f8](https://github.com/abinnovision/tallyrelease/commit/81f23f8542ee4897b46fbe244bbdbcfce38affe8))
* **cli:** run git with the injected env and drop hook repository variables ([#79](https://github.com/abinnovision/tallyrelease/issues/79)) ([c008d0a](https://github.com/abinnovision/tallyrelease/commit/c008d0ac88fe4d66cf72409686e73c2ffd550274))
* **cli:** search older workflow run pages for the last success ([#74](https://github.com/abinnovision/tallyrelease/issues/74)) ([7d1002c](https://github.com/abinnovision/tallyrelease/commit/7d1002c6dce6a8b0aeb702e87f8837c6768a057d))
* **core:** import the testing fakes without vitest ([#76](https://github.com/abinnovision/tallyrelease/issues/76)) ([91c69dc](https://github.com/abinnovision/tallyrelease/commit/91c69dc36c5cb4fbd47cec360559450893842d52))
* **deps:** bump zod from 4.6.6 to 4.6.7 in the production-dependencies group ([#84](https://github.com/abinnovision/tallyrelease/issues/84)) ([880286d](https://github.com/abinnovision/tallyrelease/commit/880286d582b8a70ee790056f72a1ac76829b0ca8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.5.0

## [0.4.1](https://github.com/abinnovision/tallyrelease/compare/cli-v0.4.0...cli-v0.4.1) (2026-10-17)


### Bug Fixes

* **cli:** title shared release PRs after the branch ([#67](https://github.com/abinnovision/tallyrelease/issues/67)) ([5ab65fd](https://github.com/abinnovision/tallyrelease/commit/5ab65fd9573afbe0d82282ca5653b08a20858a6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.4.1

## [0.4.0](https://github.com/abinnovision/tallyrelease/compare/cli-v0.3.2...cli-v0.4.0) (2026-10-17)


### Features

* add a forge object to released entries ([#60](https://github.com/abinnovision/tallyrelease/issues/60)) ([7647a2d](https://github.com/abinnovision/tallyrelease/commit/7647a2d2d018a4fc2a8d09417491f80866f8b8ea))
* **cli:** list the changes of each release in the run output ([#59](https://github.com/abinnovision/tallyrelease/issues/59)) ([5c2494c](https://github.com/abinnovision/tallyrelease/commit/5c2494cf749caaae93cf817d378694a4316483b0))
* **cli:** list unit tags and group on release entries ([#64](https://github.com/abinnovision/tallyrelease/issues/64)) ([7dc24d2](https://github.com/abinnovision/tallyrelease/commit/7dc24d254c74f557174b21b823a053a7b20404fa))
* **cli:** suggest a maintenance branch in major release PRs ([#55](https://github.com/abinnovision/tallyrelease/issues/55)) ([bc13891](https://github.com/abinnovision/tallyrelease/commit/bc138913fd6db49c25ff0871d0506a62fc0521ac))
* **core:** accept glob keys in unit overlays ([#61](https://github.com/abinnovision/tallyrelease/issues/61)) ([32c19b4](https://github.com/abinnovision/tallyrelease/commit/32c19b4258d9b6eed098bb9709fd9879542b9c3a))
* **core:** keep releases at HEAD in the build set ([#62](https://github.com/abinnovision/tallyrelease/issues/62)) ([2e4c1ea](https://github.com/abinnovision/tallyrelease/commit/2e4c1ea81b3885c75a057a22765aae26c07ba302))
* list propagated changes on release entries and drop deprecated fields ([#66](https://github.com/abinnovision/tallyrelease/issues/66)) ([df5ead8](https://github.com/abinnovision/tallyrelease/commit/df5ead84d5be8def8601d037f80d8b65edca443c))
* mark the latest release of each unit ([#63](https://github.com/abinnovision/tallyrelease/issues/63)) ([3b7a7cb](https://github.com/abinnovision/tallyrelease/commit/3b7a7cb4b0f51568d909acad0e6c209b79575713))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.4.0

## [0.3.2](https://github.com/abinnovision/tallyrelease/compare/cli-v0.3.1...cli-v0.3.2) (2026-10-16)


### Bug Fixes

* **cli:** commit releases as the configured git identity ([#53](https://github.com/abinnovision/tallyrelease/issues/53)) ([0b741b8](https://github.com/abinnovision/tallyrelease/commit/0b741b87ed8e00ffe4fd497e4b662e9a1796851c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.3.2

## [0.3.1](https://github.com/abinnovision/tallyrelease/compare/cli-v0.3.0...cli-v0.3.1) (2026-10-16)


### Bug Fixes

* **core:** count prereleases from a unit's introduction without a line base ([#48](https://github.com/abinnovision/tallyrelease/issues/48)) ([06a591b](https://github.com/abinnovision/tallyrelease/commit/06a591b3522cf60ce5bde56e393f464617ffa101))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.3.1

## [0.3.0](https://github.com/abinnovision/tallyrelease/compare/cli-v0.2.0...cli-v0.3.0) (2026-10-16)


### Features

* **cli:** add kustomize plugin for affected detection ([#45](https://github.com/abinnovision/tallyrelease/issues/45)) ([781e6c5](https://github.com/abinnovision/tallyrelease/commit/781e6c5d96add66d27095aa85116889f4f885615))
* **cli:** add release forge methods and a git writer ([#31](https://github.com/abinnovision/tallyrelease/issues/31)) ([608dfdf](https://github.com/abinnovision/tallyrelease/commit/608dfdfdbcf683f183dd818b06f54fb37aebb02e))
* **cli:** add tallyrelease pr for shared and separate release PRs ([#34](https://github.com/abinnovision/tallyrelease/issues/34)) ([5dbb294](https://github.com/abinnovision/tallyrelease/commit/5dbb2944a6f9535511710cbcfa5c6ddfccb14fe8))
* **cli:** add tallyrelease run and fill released in plans ([#36](https://github.com/abinnovision/tallyrelease/issues/36)) ([8d90546](https://github.com/abinnovision/tallyrelease/commit/8d905469ed398a6daaa0e09f4fd9eb9c4c79c818))
* **cli:** write the releases list from tallyrelease run ([#37](https://github.com/abinnovision/tallyrelease/issues/37)) ([bc93e36](https://github.com/abinnovision/tallyrelease/commit/bc93e367b16fd3bcb8c76293e33cc6a58efe5eca))
* **core:** add changelog writer, release items and PR marker ([#30](https://github.com/abinnovision/tallyrelease/issues/30)) ([e74244e](https://github.com/abinnovision/tallyrelease/commit/e74244ebc4752e3de39614159ef0761f1cd2a33c))
* tag merged release PRs with tallyrelease release ([#35](https://github.com/abinnovision/tallyrelease/issues/35)) ([0058045](https://github.com/abinnovision/tallyrelease/commit/005804542b3f0b18a1a5afdb1a559231f8d10b4d))
* write version files and changelogs with tallyrelease version ([#33](https://github.com/abinnovision/tallyrelease/issues/33)) ([5961ce0](https://github.com/abinnovision/tallyrelease/commit/5961ce0c56b7ddbb4bff2cf154d5b5556212e8cb))


### Bug Fixes

* **cli:** do not log expected 404 responses ([#43](https://github.com/abinnovision/tallyrelease/issues/43)) ([58b7461](https://github.com/abinnovision/tallyrelease/commit/58b74615123ce5b960f2022baf0e7a08014be777))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.3.0

## [0.2.0](https://github.com/abinnovision/tallyrelease/compare/cli-v0.1.1...cli-v0.2.0) (2026-10-15)


### Features

* add fixed groups ([#23](https://github.com/abinnovision/tallyrelease/issues/23)) ([9822ded](https://github.com/abinnovision/tallyrelease/commit/9822dedcb572b852348e7df3577d101bf4d70e62))
* **cli:** add plan --summary for GitHub step summaries ([#28](https://github.com/abinnovision/tallyrelease/issues/28)) ([7f6f156](https://github.com/abinnovision/tallyrelease/commit/7f6f156b291ed138a5dc170fc2a48dc332702e7a))
* **cli:** add plan and explain commands ([#20](https://github.com/abinnovision/tallyrelease/issues/20)) ([4a68ff1](https://github.com/abinnovision/tallyrelease/commit/4a68ff10092b44fb994fd62f86a51b7af4bdbd5f))
* **cli:** add shadow comparison against release-please ([#21](https://github.com/abinnovision/tallyrelease/issues/21)) ([2623aae](https://github.com/abinnovision/tallyrelease/commit/2623aaee6e8e653218f5623658e25fa97de62176))
* **core:** absorb internal changes as patch by default ([#22](https://github.com/abinnovision/tallyrelease/issues/22)) ([947b85f](https://github.com/abinnovision/tallyrelease/commit/947b85fd442ca650f0a47ee2349ffe41b9ea5b69))
* **core:** compute release versions with computePlan ([#18](https://github.com/abinnovision/tallyrelease/issues/18)) ([0341c3e](https://github.com/abinnovision/tallyrelease/commit/0341c3eea127abf32c1eda59344481a3ee506e84))
* **core:** match unit tags and collect plan facts ([#17](https://github.com/abinnovision/tallyrelease/issues/17)) ([828f9bd](https://github.com/abinnovision/tallyrelease/commit/828f9bd427b6e69419bdbb00d6570edee0cd9e0e))
* enforce maintenance branch limits ([#24](https://github.com/abinnovision/tallyrelease/issues/24)) ([c5e382b](https://github.com/abinnovision/tallyrelease/commit/c5e382bb1d58430555b85d8076659272353c1e30))


### Bug Fixes

* **cli:** fail on unreadable git blobs instead of treating them as absent ([#29](https://github.com/abinnovision/tallyrelease/issues/29)) ([1b5cad9](https://github.com/abinnovision/tallyrelease/commit/1b5cad9026c99fd687f60aecadf3e5cf69c9a47e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.2.0

## [0.1.1](https://github.com/abinnovision/tallyrelease/compare/cli-v0.1.0...cli-v0.1.1) (2026-10-15)


### Bug Fixes

* add unit tags and an affected --tag filter ([#14](https://github.com/abinnovision/tallyrelease/issues/14)) ([733e556](https://github.com/abinnovision/tallyrelease/commit/733e55642dc582e24e06d2e2b118110547ace742))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.1.1

## 0.1.0 (2026-10-15)


### Features

* bootstrap tallyrelease with build selection (v0.1) ([#1](https://github.com/abinnovision/tallyrelease/issues/1)) ([4efde72](https://github.com/abinnovision/tallyrelease/commit/4efde72e32091df3c84a2b497272a3a0efdac659))
* **cli:** align human-readable output and add a local build base ([#8](https://github.com/abinnovision/tallyrelease/issues/8)) ([96cb5f0](https://github.com/abinnovision/tallyrelease/commit/96cb5f010f3090806da4317a50c23ba17884c5c5))
* **cli:** publish the tallyrelease.yaml JSON schema ([#9](https://github.com/abinnovision/tallyrelease/issues/9)) ([c5b5c94](https://github.com/abinnovision/tallyrelease/commit/c5b5c946315fdcab2a486cfc2eeef5dd47b6a8f8))
* **cli:** render the unit graph as mermaid ([#7](https://github.com/abinnovision/tallyrelease/issues/7)) ([297413a](https://github.com/abinnovision/tallyrelease/commit/297413a06534b803c5e98e3ee84cb8921bdebdd6))
* make units build-only unless opted into release ([#6](https://github.com/abinnovision/tallyrelease/issues/6)) ([4b01768](https://github.com/abinnovision/tallyrelease/commit/4b0176809d38504eec22e35168f57ca17840ef13))


### Bug Fixes

* **cli:** clearer errors and package docs for the 0.1.0 release ([#11](https://github.com/abinnovision/tallyrelease/issues/11)) ([85fc7ed](https://github.com/abinnovision/tallyrelease/commit/85fc7ed70693bae01c9b90319d808f72f5eef6f6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @tallyrelease/core bumped to 0.1.0
